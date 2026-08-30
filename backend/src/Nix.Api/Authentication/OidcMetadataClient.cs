using System.Text.Json;
using Microsoft.Extensions.Options;

namespace Nix.Authentication;

/// <summary>Bounded same-origin discovery for the configured interactive provider.</summary>
public sealed class OidcMetadataClient(
    IHttpClientFactory clientFactory,
    IOptions<BrowserAuthOptions> configured) : IDisposable
{
    private const int MaximumDocumentBytes = 32 * 1024;
    private static readonly TimeSpan DiscoveryDeadline = TimeSpan.FromSeconds(10);
    private readonly SemaphoreSlim _gate = new(1, 1);
    private OidcMetadata? _cached;

    /// <summary>Gets validated OIDC endpoints, cached for this process.</summary>
    public async ValueTask<OidcMetadata> GetAsync(CancellationToken cancellationToken)
    {
        if (_cached is { } cached)
        {
            return cached;
        }

        await _gate.WaitAsync(cancellationToken).ConfigureAwait(false);
        try
        {
            if (_cached is { } won)
            {
                return won;
            }

            var options = configured.Value;
            if (!options.TryAuthority(out var authority))
            {
                throw new InvalidOperationException("Interactive OIDC authority is not configured safely.");
            }

            var discovery = new Uri(authority, "/.well-known/openid-configuration");
            using var deadline = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
            deadline.CancelAfter(DiscoveryDeadline);
            try
            {
                using var client = clientFactory.CreateClient(BrowserAuthOptions.HttpClientName);
                using var response = await client.GetAsync(
                    discovery,
                    HttpCompletionOption.ResponseHeadersRead,
                    deadline.Token).ConfigureAwait(false);
                if (!response.IsSuccessStatusCode)
                {
                    throw new InvalidOperationException("Interactive OIDC discovery was unavailable.");
                }

                var bytes = await BoundedHttpContent
                    .ReadAsync(response.Content, MaximumDocumentBytes, deadline.Token)
                    .ConfigureAwait(false);

                using var document = JsonDocument.Parse(bytes, new JsonDocumentOptions { MaxDepth = 8 });
                var root = document.RootElement;
                var issuer = ReadUri(root, "issuer");
                if (!SameOrigin(authority, issuer)
                    || !string.Equals(
                        authority.AbsoluteUri.TrimEnd('/'),
                        issuer.AbsoluteUri.TrimEnd('/'),
                        StringComparison.Ordinal))
                {
                    throw new InvalidOperationException("Interactive OIDC discovery returned another issuer.");
                }

                var metadata = new OidcMetadata(
                    issuer,
                    RequireSameOrigin(authority, ReadUri(root, "authorization_endpoint")),
                    RequireSameOrigin(authority, ReadUri(root, "token_endpoint")));
                _cached = metadata;
                return metadata;
            }
            catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
            {
                throw new InvalidOperationException("Interactive OIDC discovery timed out.");
            }
            catch (Exception exception) when (
                exception is HttpRequestException or IOException or InvalidDataException or JsonException)
            {
                throw new InvalidOperationException("Interactive OIDC discovery was invalid or unavailable.");
            }
        }
        finally
        {
            _gate.Release();
        }
    }

    private static Uri ReadUri(JsonElement root, string name)
    {
        if (!root.TryGetProperty(name, out var property)
            || property.ValueKind != JsonValueKind.String
            || !Uri.TryCreate(property.GetString(), UriKind.Absolute, out var value)
            || !string.IsNullOrEmpty(value.UserInfo)
            || !string.IsNullOrEmpty(value.Fragment))
        {
            throw new InvalidOperationException($"OIDC discovery did not provide a safe {name}.");
        }

        return value;
    }

    private static Uri RequireSameOrigin(Uri authority, Uri endpoint) => SameOrigin(authority, endpoint)
        ? endpoint
        : throw new InvalidOperationException("OIDC discovery returned a cross-origin endpoint.");

    private static bool SameOrigin(Uri left, Uri right) =>
        string.Equals(left.Scheme, right.Scheme, StringComparison.OrdinalIgnoreCase)
        && string.Equals(left.IdnHost, right.IdnHost, StringComparison.OrdinalIgnoreCase)
        && left.Port == right.Port;

    /// <inheritdoc />
    public void Dispose() => _gate.Dispose();
}

/// <summary>Validated endpoints needed by the authorization-code flow.</summary>
public sealed record OidcMetadata(Uri Issuer, Uri AuthorizationEndpoint, Uri TokenEndpoint);
