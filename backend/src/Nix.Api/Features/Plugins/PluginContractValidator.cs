using System.Text.Json;
using Nix.Domain.Plugins;
using Nix.Domain.Tenancy;
using Nix.Persistence.ObjectStorage;
using Nix.Persistence.Plugins;

namespace Nix.Features.Plugins;

/// <summary>Bounds every value that may cross the plugin catalog or worker contract.</summary>
public static class PluginContractValidator
{
    /// <summary>Validates and decodes one immutable component registration.</summary>
    public static bool TryComponent(
        TenantId tenantId,
        PluginComponentRegistrationRequest request,
        out PluginComponentRegistration registration)
    {
        ArgumentNullException.ThrowIfNull(request);
        registration = default!;
        if (!ValidPublisherId(request.PublisherId)
            || !ValidComponentId(request.PublisherId, request.Id)
            || !ValidSemanticVersion(request.Version)
            || request.Sha256 is not { Length: 64 }
            || request.Sha256.Any(character => !char.IsAsciiHexDigit(character))
            || request.ByteLength is < 1 or > PluginRuntimePolicy.MaximumComponentBytes
            || !TryFixedBase64(request.PublicKey, 32, out var publicKey)
            || !TryFixedBase64(request.Signature, 64, out var signature))
        {
            return false;
        }

        var digest = request.Sha256.ToUpperInvariant();
        string expectedKey;
        try
        {
            expectedKey = ObjectStorageKeys.PluginComponent(
                tenantId,
                request.Id,
                request.Version,
                digest);
        }
        catch (ArgumentException)
        {
            return false;
        }

        if (!string.Equals(request.ObjectKey, expectedKey, StringComparison.Ordinal))
        {
            return false;
        }

        registration = new PluginComponentRegistration(
            request.PublisherId,
            request.Id,
            request.Version,
            request.ObjectKey,
            digest,
            request.ByteLength,
            publicKey,
            signature);
        return true;
    }

    /// <summary>Whether a RabbitMQ workspace event envelope is bounded and causally valid.</summary>
    public static bool ValidEvent(
        Guid eventId,
        Guid tenantId,
        Guid workspaceId,
        Guid? itemId,
        string kind,
        long? aggregateVersion,
        Guid causationId,
        int causationDepth,
        int leaseSeconds) =>
        eventId != Guid.Empty
        && tenantId != Guid.Empty
        && workspaceId != Guid.Empty
        && itemId != Guid.Empty
        && ValidEventKind(kind)
        && aggregateVersion is null or > 0
        && causationId != Guid.Empty
        // This first runtime slice exposes reads only. Until plugin-authored mutations carry their
        // causal chain in the durable outbox, accepting a non-root event would make the bound a lie.
        && causationDepth == 0
        && causationId == eventId
        && leaseSeconds is >= 5 and <= 300;

    /// <summary>Validates the one host-call request implemented in this read-only slice.</summary>
    public static bool TryReadItemMetadata(
        string capability,
        JsonElement request,
        out Guid itemId)
    {
        itemId = Guid.Empty;
        if (!string.Equals(
                capability,
                PluginRuntimePolicy.ReadItemMetadataCapability,
                StringComparison.Ordinal)
            || request.ValueKind != JsonValueKind.Object)
        {
            return false;
        }

        var count = 0;
        foreach (var property in request.EnumerateObject())
        {
            count++;
            if (count > 1
                || !string.Equals(property.Name, "itemId", StringComparison.Ordinal)
                || property.Value.ValueKind != JsonValueKind.String
                || !property.Value.TryGetGuid(out itemId))
            {
                itemId = Guid.Empty;
                return false;
            }
        }

        return count == 1 && itemId != Guid.Empty;
    }

    /// <summary>Whether a completion report can be persisted and replay-compared safely.</summary>
    public static bool ValidCompletion(
        bool succeeded,
        bool retryable,
        string? errorCode,
        string? errorDetail)
    {
        if (succeeded)
        {
            return !retryable && errorCode is null && errorDetail is null;
        }

        return !string.IsNullOrWhiteSpace(errorCode)
            && errorCode.Length <= 64
            && errorCode.All(character => char.IsAsciiLetterOrDigit(character) || character is '_' or '.' or '-')
            && errorDetail is { Length: > 0 and <= 2000 }
            && !errorDetail.Any(char.IsControl);
    }

    /// <summary>Validates the publisher namespace pinned to one signing key.</summary>
    public static bool ValidPublisherId(string value)
    {
        if (string.IsNullOrWhiteSpace(value)
            || value.Length is < 3 or > 128
            || value[0] == '.'
            || value[^1] == '.'
            || !value.Contains('.', StringComparison.Ordinal))
        {
            return false;
        }

        var previousDot = false;
        foreach (var character in value)
        {
            if (character == '.')
            {
                if (previousDot)
                {
                    return false;
                }
                previousDot = true;
                continue;
            }

            previousDot = false;
            if (!(character is >= 'a' and <= 'z' or >= '0' and <= '9' or '-'))
            {
                return false;
            }
        }

        return true;
    }

    /// <summary>Validates a publisher-qualified component identifier.</summary>
    public static bool ValidComponentId(string publisherId, string componentId)
    {
        if (!ValidPublisherId(publisherId)
            || string.IsNullOrWhiteSpace(componentId)
            || componentId.Length > 257
            || !componentId.StartsWith(publisherId + "/", StringComparison.Ordinal))
        {
            return false;
        }

        var name = componentId[(publisherId.Length + 1)..];
        return name.Length is >= 1 and <= 128
            && name[0] is >= 'a' and <= 'z' or >= '0' and <= '9'
            && name[^1] is >= 'a' and <= 'z' or >= '0' and <= '9'
            && name.All(character => character is >= 'a' and <= 'z'
                or >= '0' and <= '9'
                or '-' or '_' or '.');
    }

    /// <summary>Validates a bounded SemVer 2.0 version without normalizing its identity.</summary>
    public static bool ValidSemanticVersion(string value)
    {
        if (string.IsNullOrWhiteSpace(value) || value.Length > 64)
        {
            return false;
        }

        var withoutBuild = value;
        var buildSeparator = value.IndexOf('+', StringComparison.Ordinal);
        if (buildSeparator >= 0)
        {
            if (value.IndexOf('+', buildSeparator + 1) >= 0
                || !ValidIdentifiers(value[(buildSeparator + 1)..], numericLeadingZeroForbidden: false))
            {
                return false;
            }

            withoutBuild = value[..buildSeparator];
        }

        var coreText = withoutBuild;
        var prereleaseSeparator = withoutBuild.IndexOf('-', StringComparison.Ordinal);
        if (prereleaseSeparator >= 0)
        {
            if (!ValidIdentifiers(
                    withoutBuild[(prereleaseSeparator + 1)..],
                    numericLeadingZeroForbidden: true))
            {
                return false;
            }

            coreText = withoutBuild[..prereleaseSeparator];
        }

        var core = coreText.Split('.');
        return core.Length == 3 && core.All(ValidCoreNumber);
    }

    private static bool ValidEventKind(string value) =>
        !string.IsNullOrWhiteSpace(value)
        && value.Length <= 64
        && value[0] is >= 'a' and <= 'z'
        && value[^1] is >= 'a' and <= 'z' or >= '0' and <= '9'
        && value.Contains('.', StringComparison.Ordinal)
        && value.All(character => character is >= 'a' and <= 'z'
            or >= '0' and <= '9'
            or '.' or '_' or '-');

    private static bool ValidCoreNumber(string value) =>
        value.Length > 0
        && (value.Length == 1 || value[0] != '0')
        && value.All(char.IsAsciiDigit);

    private static bool ValidIdentifiers(string value, bool numericLeadingZeroForbidden)
    {
        var identifiers = value.Split('.');
        return identifiers.Length > 0 && identifiers.All(identifier =>
            identifier.Length > 0
            && identifier.All(character => char.IsAsciiLetterOrDigit(character) || character == '-')
            && (!numericLeadingZeroForbidden
                || !identifier.All(char.IsAsciiDigit)
                || identifier.Length == 1
                || identifier[0] != '0'));
    }

    private static bool TryFixedBase64(string value, int expectedBytes, out byte[] bytes)
    {
        bytes = [];
        if (string.IsNullOrWhiteSpace(value) || value.Length > 128)
        {
            return false;
        }

        Span<byte> buffer = stackalloc byte[64];
        if (!Convert.TryFromBase64String(value, buffer, out var written) || written != expectedBytes)
        {
            return false;
        }

        bytes = buffer[..written].ToArray();
        return true;
    }
}

/// <summary>Untrusted wire values for one signed component registration.</summary>
public sealed record PluginComponentRegistrationRequest(
    string PublisherId,
    string Id,
    string Version,
    string ObjectKey,
    string Sha256,
    long ByteLength,
    string PublicKey,
    string Signature);
