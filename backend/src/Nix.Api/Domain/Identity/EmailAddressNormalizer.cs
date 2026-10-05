using System.Diagnostics.CodeAnalysis;
using System.Text;

namespace Nix.Domain.Identity;

/// <summary>The single normalization rule used by principals and workspace invitations.</summary>
public static class EmailAddressNormalizer
{
    /// <summary>The longest normalized email accepted by the domain, in UTF-8 bytes.</summary>
    public const int MaximumUtf8ByteLength = 320;

    /// <summary>Normalizes an address for exact authorization-sensitive matching.</summary>
    public static bool TryNormalize(
        string? value,
        [NotNullWhen(true)] out string? normalized)
    {
        normalized = null;
        if (value is null)
        {
            return false;
        }

        var trimmed = value.Trim();
        if (trimmed.Length == 0)
        {
            return false;
        }

        try
        {
#pragma warning disable CA1308 // Normalize strings to uppercase
            // Justification: ADR-0045 fixes lower-case invariant normalization as the persisted
            // cross-client email matching protocol; changing case direction would split matches.
            var candidate = trimmed.Normalize(NormalizationForm.FormC).ToLowerInvariant();
#pragma warning restore CA1308
            if (Encoding.UTF8.GetByteCount(candidate) > MaximumUtf8ByteLength)
            {
                return false;
            }

            normalized = candidate;
            return true;
        }
        catch (ArgumentException)
        {
            return false;
        }
    }
}
