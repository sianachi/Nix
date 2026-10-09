using System.Security.Cryptography;
using System.Text;

namespace Nix.Domain.Views;

/// <summary>An opaque version of the exact durable view configuration read for a replacement.</summary>
public static class ViewConfigurationVersion
{
    /// <summary>Hashes stored JSON; absent configuration has its own distinct version.</summary>
    /// <param name="views">The stored JSON, or SQL null when no configuration exists.</param>
    /// <returns>A lowercase SHA-256 version, independent of item modification timestamps.</returns>
    public static string FromStored(string? views)
    {
        // View JSON is bounded to 32 KiB by every write. This one bounded UTF-8 allocation lets
        // SHA-256 fingerprint all stored settings, including fields a projection does not read.
        var bytes = views is null ? new byte[] { 0 } : Encoding.UTF8.GetBytes(views); // byte[]: SHA-256 requires bounded UTF-8 input; SQL null uses one byte.
        return Convert.ToHexStringLower(SHA256.HashData(bytes));
    }
}
