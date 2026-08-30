using System.Buffers.Text;
using System.Security.Cryptography;
using System.Text;

namespace Nix.Domain.Identity;

/// <summary>Mints and hashes the opaque secret held only by the browser cookie.</summary>
public static class BrowserSessionSecret
{
    /// <summary>The prefix recognized by secret scanners.</summary>
    public const string Prefix = "nixsession_";

    private const int SecretBytes = 32;

    /// <summary>Mints a random cookie token and the lowercase SHA-256 stored in its place.</summary>
    public static MintedBrowserSessionSecret Mint()
    {
        var token = Prefix + Base64Url.EncodeToString(RandomNumberGenerator.GetBytes(SecretBytes));
        return new MintedBrowserSessionSecret(token, Hash(token));
    }

    /// <summary>Hashes a presented cookie token for the indexed exact lookup.</summary>
    public static string Hash(string token)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(token);
        return Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(token)));
    }
}

/// <summary>A freshly minted cookie secret and the only value persisted from it.</summary>
/// <param name="Token">The secret sent once as an HttpOnly cookie.</param>
/// <param name="Hash">The SHA-256 lookup stored by Core.</param>
public sealed record MintedBrowserSessionSecret(string Token, string Hash);
