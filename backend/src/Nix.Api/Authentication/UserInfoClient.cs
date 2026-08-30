using System.Buffers;
using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using Nix.Abstractions;
using Nix.Domain.Identity;

namespace Nix.Authentication;

/// <summary>Bounded, fail-closed OIDC UserInfo reader for JIT provisioning.</summary>
public sealed class UserInfoClient : IUserInfoClient
{
    internal const int MaximumResponseBytes = 32 * 1024;
    internal static readonly TimeSpan RequestTimeout = TimeSpan.FromSeconds(5);

    private const int MaximumSubjectBytes = 1024;
    private const int MaximumDisplayNameBytes = 200;
    private const int MaximumEmailBytes = 1024;
    private readonly HttpClient _client;
    private readonly TimeSpan _requestTimeout;

    /// <summary>Initializes a UserInfo reader over the separately hardened client.</summary>
    public UserInfoClient(HttpClient client)
        : this(client, RequestTimeout)
    {
    }

    /// <summary>Initializes a reader with an explicit end-to-end timeout.</summary>
    public UserInfoClient(HttpClient client, TimeSpan requestTimeout)
    {
        ArgumentNullException.ThrowIfNull(client);
        ArgumentOutOfRangeException.ThrowIfLessThanOrEqual(requestTimeout, TimeSpan.Zero);
        _client = client;
        _requestTimeout = requestTimeout;
    }

    /// <inheritdoc />
    public async ValueTask<UserInfoProfile> ReadAsync(
        Uri endpoint,
        string validatedIssuer,
        string accessToken,
        string expectedSubject,
        CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(endpoint);
        ArgumentException.ThrowIfNullOrWhiteSpace(validatedIssuer);
        ArgumentException.ThrowIfNullOrWhiteSpace(accessToken);
        ArgumentException.ThrowIfNullOrWhiteSpace(expectedSubject);

        if (!IsAllowedEndpoint(endpoint, validatedIssuer))
        {
            throw new UserInfoUnavailableException(ProvisioningFailureCategory.Endpoint);
        }

        using var request = new HttpRequestMessage(HttpMethod.Get, endpoint);
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", accessToken);
        request.Headers.Accept.Add(new MediaTypeWithQualityHeaderValue("application/json"));

        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        timeout.CancelAfter(_requestTimeout);
        var requestCancellation = timeout.Token;

        HttpResponseMessage response;
        try
        {
            response = await _client.SendAsync(
                request,
                HttpCompletionOption.ResponseHeadersRead,
                requestCancellation).ConfigureAwait(false);
        }
        catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
        {
            throw new UserInfoUnavailableException(ProvisioningFailureCategory.UserInfoTimeout);
        }
        catch (Exception exception) when (exception is HttpRequestException or IOException)
        {
            throw new UserInfoUnavailableException(exception);
        }

        try
        {
            using (response)
            {
                if (!response.IsSuccessStatusCode
                    || response.Content.Headers.ContentLength is > MaximumResponseBytes)
                {
                    throw new UserInfoUnavailableException(!response.IsSuccessStatusCode
                        ? ProvisioningFailureCategory.UserInfoStatus
                        : ProvisioningFailureCategory.UserInfoMalformed);
                }

                var rented = ArrayPool<byte>.Shared.Rent(MaximumResponseBytes + 1);
                try
                {
                    var length = await ReadBoundedAsync(response.Content, rented, requestCancellation)
                        .ConfigureAwait(false);
                    return Parse(rented.AsSpan(0, length), expectedSubject);
                }
                finally
                {
                    ArrayPool<byte>.Shared.Return(rented, clearArray: true);
                }
            }
        }
        catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
        {
            throw new UserInfoUnavailableException(ProvisioningFailureCategory.UserInfoTimeout);
        }
        catch (Exception exception) when (exception is HttpRequestException or IOException)
        {
            throw new UserInfoUnavailableException(exception);
        }
    }

    internal static UserInfoProfile Parse(ReadOnlySpan<byte> json, string expectedSubject)
    {
        try
        {
            var reader = new Utf8JsonReader(json, new JsonReaderOptions
            {
                AllowTrailingCommas = false,
                CommentHandling = JsonCommentHandling.Disallow,
                MaxDepth = 8,
            });

            if (!reader.Read() || reader.TokenType != JsonTokenType.StartObject)
            {
                throw new UserInfoUnavailableException();
            }

            var names = new HashSet<string>(StringComparer.Ordinal);
            string? subject = null;
            string? name = null;
            string? preferredUsername = null;
            string? email = null;
            var emailVerified = false;

            while (reader.Read() && reader.TokenType != JsonTokenType.EndObject)
            {
                if (reader.TokenType != JsonTokenType.PropertyName)
                {
                    throw new UserInfoUnavailableException();
                }

                var propertyName = reader.GetString();
                if (propertyName is null || !names.Add(propertyName) || !reader.Read())
                {
                    throw new UserInfoUnavailableException();
                }

                switch (propertyName)
                {
                    case "sub":
                        subject = ReadString(ref reader, MaximumSubjectBytes, required: true);
                        break;
                    case "name":
                        name = ReadString(ref reader, MaximumDisplayNameBytes, required: false);
                        break;
                    case "preferred_username":
                        preferredUsername = ReadString(ref reader, MaximumDisplayNameBytes, required: false);
                        break;
                    case "email":
                        email = ReadString(ref reader, MaximumEmailBytes, required: false);
                        break;
                    case "email_verified":
                        if (reader.TokenType is not (JsonTokenType.True or JsonTokenType.False))
                        {
                            throw new UserInfoUnavailableException();
                        }

                        emailVerified = reader.GetBoolean();
                        break;
                    default:
                        reader.Skip();
                        break;
                }
            }

            if (reader.TokenType != JsonTokenType.EndObject || reader.Read()
                || subject is null
                || !string.Equals(subject, expectedSubject, StringComparison.Ordinal))
            {
                throw new UserInfoUnavailableException();
            }

            var suppliedDisplayName = FirstUsable(name, preferredUsername);
            var usableEmail = string.IsNullOrWhiteSpace(email) ? null : email.Trim();
            if (emailVerified && usableEmail is not null
                && !EmailAddressNormalizer.TryNormalize(usableEmail, out _))
            {
                throw new UserInfoUnavailableException();
            }

            return new UserInfoProfile(
                suppliedDisplayName,
                usableEmail,
                emailVerified && usableEmail is not null);
        }
        catch (JsonException exception)
        {
            throw new UserInfoUnavailableException(ProvisioningFailureCategory.UserInfoMalformed, exception);
        }
        catch (DecoderFallbackException exception)
        {
            throw new UserInfoUnavailableException(ProvisioningFailureCategory.UserInfoMalformed, exception);
        }
    }

    private static bool IsAllowedEndpoint(Uri endpoint, string validatedIssuer)
    {
        if (!Uri.TryCreate(validatedIssuer, UriKind.Absolute, out var issuer)
            || !endpoint.IsAbsoluteUri
            || endpoint.Scheme != Uri.UriSchemeHttps
            || issuer.Scheme != Uri.UriSchemeHttps
            || endpoint.UserInfo.Length != 0
            || endpoint.Fragment.Length != 0
            || issuer.UserInfo.Length != 0)
        {
            return false;
        }

        return string.Equals(endpoint.Scheme, issuer.Scheme, StringComparison.OrdinalIgnoreCase)
            && string.Equals(endpoint.IdnHost, issuer.IdnHost, StringComparison.OrdinalIgnoreCase)
            && endpoint.Port == issuer.Port;
    }

    private static async ValueTask<int> ReadBoundedAsync(
        HttpContent content,
        byte[] destination,
        CancellationToken cancellationToken)
    {
        var stream = await content.ReadAsStreamAsync(cancellationToken).ConfigureAwait(false);
        await using (stream.ConfigureAwait(false))
        {
            var total = 0;
            while (total <= MaximumResponseBytes)
            {
                var read = await stream.ReadAsync(
                    destination.AsMemory(total, MaximumResponseBytes + 1 - total),
                    cancellationToken).ConfigureAwait(false);
                if (read == 0)
                {
                    return total;
                }

                total += read;
            }
        }

        throw new UserInfoUnavailableException();
    }

    private static string? ReadString(ref Utf8JsonReader reader, int maximumBytes, bool required)
    {
        if (reader.TokenType == JsonTokenType.Null && !required)
        {
            return null;
        }

        if (reader.TokenType != JsonTokenType.String)
        {
            throw new UserInfoUnavailableException();
        }

        var value = reader.GetString();
        if (value is null || (required && string.IsNullOrWhiteSpace(value))
            || Encoding.UTF8.GetByteCount(value) > maximumBytes)
        {
            throw new UserInfoUnavailableException();
        }

        return value;
    }

    private static string? FirstUsable(params string?[] candidates)
    {
        foreach (var candidate in candidates)
        {
            if (!string.IsNullOrWhiteSpace(candidate))
            {
                return candidate.Trim();
            }
        }

        return null;
    }
}
