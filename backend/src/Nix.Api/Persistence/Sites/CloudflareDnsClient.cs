using System.Globalization;
using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json;
using System.Text.Json.Nodes;
using Nix.Abstractions;

namespace Nix.Persistence.Sites;

/// <summary>
/// The Cloudflare v4 API over HTTP with the operator's token. The token is set per request from
/// configuration and never appears in a URL, a log line or an exception message; failures carry
/// the HTTP status and Cloudflare's numeric error codes only.
/// </summary>
public sealed class CloudflareDnsClient(HttpClient http, string apiToken, string accountId, string? tunnelId) : ICloudflareDns
{
    /// <summary>The named client this implementation uses.</summary>
    public const string HttpClientName = "nix-sites-cloudflare";

    /// <summary>The API root.</summary>
    public static readonly Uri BaseAddress = new("https://api.cloudflare.com/client/v4/");

    /// <inheritdoc />
    public async Task<string?> FindZoneIdAsync(string zoneName, CancellationToken cancellationToken)
    {
        var path = "zones?name=" + Uri.EscapeDataString(zoneName)
            + (accountId.Length > 0 ? "&account.id=" + Uri.EscapeDataString(accountId) : string.Empty);
        var result = await SendAsync(HttpMethod.Get, path, null, cancellationToken).ConfigureAwait(false);
        return result is JsonArray { Count: > 0 } zones ? zones[0]?["id"]?.GetValue<string>() : null;
    }

    /// <inheritdoc />
    public async Task<IReadOnlyList<CloudflareDnsRecord>> ListRecordsAsync(string zoneId, string name, CancellationToken cancellationToken)
    {
        var result = await SendAsync(
            HttpMethod.Get, $"zones/{Segment(zoneId)}/dns_records?per_page=100&name={Uri.EscapeDataString(name)}", null, cancellationToken)
            .ConfigureAwait(false);
        return result is JsonArray records ? [.. records.OfType<JsonObject>().Select(ToRecord)] : [];
    }

    /// <inheritdoc />
    public async Task<CloudflareDnsRecord> CreateRecordAsync(string zoneId, CloudflareDnsRecordInput record, CancellationToken cancellationToken) =>
        ToRecord(await SendAsync(HttpMethod.Post, $"zones/{Segment(zoneId)}/dns_records", Body(record), cancellationToken).ConfigureAwait(false) as JsonObject
            ?? throw new CloudflareApiException("cloudflare_malformed"));

    /// <inheritdoc />
    public async Task<CloudflareDnsRecord> UpdateRecordAsync(string zoneId, string recordId, CloudflareDnsRecordInput record, CancellationToken cancellationToken) =>
        ToRecord(await SendAsync(HttpMethod.Put, $"zones/{Segment(zoneId)}/dns_records/{Segment(recordId)}", Body(record), cancellationToken).ConfigureAwait(false) as JsonObject
            ?? throw new CloudflareApiException("cloudflare_malformed"));

    /// <inheritdoc />
    public async Task DeleteRecordAsync(string zoneId, string recordId, CancellationToken cancellationToken) =>
        _ = await SendAsync(HttpMethod.Delete, $"zones/{Segment(zoneId)}/dns_records/{Segment(recordId)}", null, cancellationToken, allowNotFound: true)
            .ConfigureAwait(false);

    /// <inheritdoc />
    public async Task<JsonObject> GetTunnelConfigAsync(CancellationToken cancellationToken)
    {
        var result = await SendAsync(HttpMethod.Get, TunnelPath(), null, cancellationToken).ConfigureAwait(false);
        // Never answer "empty": a write built on an empty object would replace every rule of the tunnel.
        return result?["config"] is JsonObject config
            ? (JsonObject)config.DeepClone()
            : throw new CloudflareApiException("cloudflare_malformed");
    }

    /// <inheritdoc />
    public async Task PutTunnelConfigAsync(JsonObject config, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(config);
        _ = await SendAsync(HttpMethod.Put, TunnelPath(), new JsonObject { ["config"] = config.DeepClone() }, cancellationToken).ConfigureAwait(false);
    }

    private string TunnelPath() =>
        tunnelId is { Length: > 0 } tunnel
            ? $"accounts/{Segment(accountId)}/cfd_tunnel/{Segment(tunnel)}/configurations"
            : throw new InvalidOperationException("No tunnel is configured.");

    private static string Segment(string value) => Uri.EscapeDataString(value);

    private static JsonObject Body(CloudflareDnsRecordInput record) => record is null ? throw new ArgumentNullException(nameof(record)) : new()
    {
        ["type"] = record.Type,
        ["name"] = record.Name,
        ["content"] = record.Content,
        ["proxied"] = record.Proxied,
        ["ttl"] = 1,
        ["comment"] = record.Comment,
    };

    private static CloudflareDnsRecord ToRecord(JsonObject record) => new(
        record["id"]?.GetValue<string>() ?? throw new CloudflareApiException("cloudflare_malformed"),
        record["type"]?.GetValue<string>() ?? string.Empty,
        record["name"]?.GetValue<string>() ?? string.Empty,
        record["content"]?.GetValue<string>() ?? string.Empty,
        record["proxied"]?.GetValue<bool>() ?? false,
        record["comment"]?.GetValue<string>());

    private async Task<JsonNode?> SendAsync(
        HttpMethod method, string path, JsonObject? body, CancellationToken cancellationToken, bool allowNotFound = false)
    {
        using var request = new HttpRequestMessage(method, new Uri(BaseAddress, path));
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", apiToken);
        if (body is not null)
        {
            request.Content = JsonContent.Create(body);
        }

        HttpResponseMessage response;
        try
        {
            response = await http.SendAsync(request, cancellationToken).ConfigureAwait(false);
        }
        catch (Exception exception) when (exception is HttpRequestException or TaskCanceledException && !cancellationToken.IsCancellationRequested)
        {
            throw new CloudflareApiException("cloudflare_unreachable", exception);
        }

        using (response)
        {
            if (allowNotFound && response.StatusCode == HttpStatusCode.NotFound)
            {
                return null;
            }

            JsonNode? envelope;
            try
            {
                envelope = await response.Content.ReadFromJsonAsync<JsonNode>(cancellationToken).ConfigureAwait(false);
            }
            catch (JsonException exception)
            {
                throw new CloudflareApiException("cloudflare_malformed", exception);
            }

            if (!response.IsSuccessStatusCode || envelope?["success"]?.GetValue<bool>() != true)
            {
                var codes = envelope?["errors"] is JsonArray errors
                    ? string.Join(',', errors.Select(error => error?["code"]?.ToString()).Where(code => code is not null))
                    : string.Empty;
                throw new CloudflareApiException(
                    "cloudflare_" + ((int)response.StatusCode).ToString(CultureInfo.InvariantCulture) + (codes.Length > 0 ? ":" + codes : string.Empty));
            }

            return envelope["result"];
        }
    }
}
