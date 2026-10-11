using System.Globalization;
using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using Nix.Abstractions;

namespace Nix.Persistence.Sites;

/// <summary>
/// DNS over HTTPS through the JSON API that Cloudflare (<c>1.1.1.1</c>) and Google serve. The
/// endpoint is operator configuration; a lookup sends only a name and a type as query parameters,
/// so a hostname a manager typed can never make Core fetch an address of their choosing.
/// </summary>
public sealed class DohSiteDnsResolver(HttpClient http, Uri endpoint) : ISiteDnsResolver
{
    /// <summary>The named client this resolver uses.</summary>
    public const string HttpClientName = "nix-sites-doh";

    private const int MaximumResponseBytes = 64 * 1024;

    private static readonly Dictionary<string, int> TypeCodes = new(StringComparer.Ordinal)
    {
        ["A"] = 1,
        ["CNAME"] = 5,
        ["TXT"] = 16,
        ["AAAA"] = 28,
    };

    /// <inheritdoc />
    public async Task<IReadOnlyList<string>> QueryAsync(string name, string type, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(name);
        if (!TypeCodes.TryGetValue(type, out var code))
        {
            throw new ArgumentOutOfRangeException(nameof(type));
        }

        var uri = new Uri(endpoint, $"?name={Uri.EscapeDataString(name)}&type={type}");
        using var request = new HttpRequestMessage(HttpMethod.Get, uri);
        request.Headers.Accept.Add(new MediaTypeWithQualityHeaderValue("application/dns-json"));
        try
        {
            using var response = await http.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, cancellationToken).ConfigureAwait(false);
            if (!response.IsSuccessStatusCode || response.Content.Headers.ContentLength > MaximumResponseBytes)
            {
                throw new SiteDnsUnavailableException("The resolver answered " + ((int)response.StatusCode).ToString(CultureInfo.InvariantCulture) + ".");
            }

            var stream = await response.Content.ReadAsStreamAsync(cancellationToken).ConfigureAwait(false);
            await using (stream.ConfigureAwait(false))
            {
                using var document = await JsonDocument.ParseAsync(stream, default, cancellationToken).ConfigureAwait(false);
                return Read(document.RootElement, code);
            }
        }
        catch (Exception exception) when (exception is HttpRequestException or JsonException or TaskCanceledException && !cancellationToken.IsCancellationRequested)
        {
            throw new SiteDnsUnavailableException("The resolver could not be reached.", exception);
        }
    }

    /// <summary>Reads the answers of one type from a JSON API reply. NXDOMAIN and NODATA are empty.</summary>
    /// <param name="root">The reply.</param>
    /// <param name="code">The numeric record type.</param>
    /// <returns>The answer data.</returns>
    public static IReadOnlyList<string> Read(JsonElement root, int code)
    {
        var status = root.TryGetProperty("Status", out var value) && value.ValueKind == JsonValueKind.Number ? value.GetInt32() : -1;
        if (status == 3)
        {
            return [];
        }

        if (status != 0)
        {
            throw new SiteDnsUnavailableException("The resolver answered DNS status " + status.ToString(CultureInfo.InvariantCulture) + ".");
        }

        if (!root.TryGetProperty("Answer", out var answers) || answers.ValueKind != JsonValueKind.Array)
        {
            return [];
        }

        var found = new List<string>();
        foreach (var answer in answers.EnumerateArray())
        {
            if (answer.TryGetProperty("type", out var type) && type.ValueKind == JsonValueKind.Number && type.GetInt32() == code
                && answer.TryGetProperty("data", out var data) && data.ValueKind == JsonValueKind.String)
            {
                var text = data.GetString()!;
                found.Add(code == 16 ? Unquote(text) : text.TrimEnd('.'));
            }
        }

        return found;
    }

    // A TXT record's data is one or more quoted character strings; the record's value is them joined.
    private static string Unquote(string data)
    {
        if (!data.StartsWith('"'))
        {
            return data;
        }

        var builder = new StringBuilder(data.Length);
        var inside = false;
        for (var index = 0; index < data.Length; index++)
        {
            var character = data[index];
            if (character == '\\' && inside && index + 1 < data.Length)
            {
                builder.Append(data[++index]);
            }
            else if (character == '"')
            {
                inside = !inside;
            }
            else if (inside)
            {
                builder.Append(character);
            }
        }

        return builder.ToString();
    }
}
