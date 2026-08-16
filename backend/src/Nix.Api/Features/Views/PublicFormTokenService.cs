using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Microsoft.AspNetCore.WebUtilities;
using Nix.Domain.Identity;
using Nix.Domain.Tenancy;

namespace Nix.Features.Views;

public sealed record PublicFormTokenPayload(
    Guid TenantId,
    Guid LinkId,
    Guid SubmissionPrincipalId,
    string Nonce);

#pragma warning disable CA1812 // Constructed by ASP.NET Core dependency injection.
public sealed class PublicFormTokenService
{
    public const string SigningKeyConfiguration = "Nix:PublicForms:SigningKey";

    private readonly byte[]? _key;

    public PublicFormTokenService(IConfiguration configuration)
    {
        ArgumentNullException.ThrowIfNull(configuration);
        var configured = configuration[SigningKeyConfiguration];
        _key = string.IsNullOrWhiteSpace(configured) ? null : Encoding.UTF8.GetBytes(configured);
    }

    public bool IsConfigured => _key is { Length: >= 32 };

    public string Create(
        TenantId tenantId,
        Guid linkId,
        PrincipalId submissionPrincipalId,
        string nonce)
    {
        if (!IsConfigured)
        {
            throw new InvalidOperationException(
                $"{SigningKeyConfiguration} must contain at least 32 bytes before forms can be published.");
        }

        var payload = JsonSerializer.SerializeToUtf8Bytes(
            new PublicFormTokenPayload(tenantId.Value, linkId, submissionPrincipalId.Value, nonce));
        var encoded = WebEncoders.Base64UrlEncode(payload);
        var signature = HMACSHA256.HashData(_key!, Encoding.ASCII.GetBytes(encoded));
        return $"{encoded}.{WebEncoders.Base64UrlEncode(signature)}";
    }

    public bool TryRead(string? token, out PublicFormTokenPayload payload)
    {
        payload = default!;
        if (!IsConfigured || string.IsNullOrWhiteSpace(token))
        {
            return false;
        }

        var separator = token.IndexOf('.', StringComparison.Ordinal);
        if (separator <= 0 || separator == token.Length - 1)
        {
            return false;
        }

        try
        {
            var encoded = token[..separator];
            var supplied = WebEncoders.Base64UrlDecode(token[(separator + 1)..]);
            var expected = HMACSHA256.HashData(_key!, Encoding.ASCII.GetBytes(encoded));
            if (!CryptographicOperations.FixedTimeEquals(supplied, expected))
            {
                return false;
            }

            payload = JsonSerializer.Deserialize<PublicFormTokenPayload>(WebEncoders.Base64UrlDecode(encoded))!;
            return payload is not null
                && payload.TenantId != Guid.Empty
                && payload.LinkId != Guid.Empty
                && payload.SubmissionPrincipalId != Guid.Empty
                && !string.IsNullOrWhiteSpace(payload.Nonce);
        }
        catch (FormatException)
        {
            return false;
        }
        catch (JsonException)
        {
            return false;
        }
    }
}
#pragma warning restore CA1812
