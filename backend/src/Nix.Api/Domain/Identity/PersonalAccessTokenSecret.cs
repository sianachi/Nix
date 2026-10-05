using System.Buffers.Text;
using System.Security.Cryptography;
using System.Text;

namespace Nix.Domain.Identity;

/// <summary>
/// The one secret a personal access token ever has, and the arithmetic around it: minting,
/// recognising, hashing and comparing.
/// </summary>
/// <remarks>
/// <para>
/// <b>Shape:</b> <c>nixpat_</c> + twelve lookup characters + forty-three secret characters, always
/// sixty-two characters in total. The distinctive prefix exists for secret scanners - a leaked
/// token in a repository or a log should match a rule, not a reviewer's eye. The lookup half is
/// stored in the clear and indexed, so authentication is one indexed read; the secret half is
/// never stored, only its hash. Fixed positions rather than a separator, because the secret's
/// alphabet (base64url) contains the underscore the prefix uses.
/// </para>
/// <para>
/// <b>The hash is a single unsalted SHA-256, and that is a decision, not an omission.</b> Key
/// derivation functions exist to slow the brute-forcing of low-entropy secrets people chose.
/// This secret is thirty-two bytes from the platform's CSPRNG - there is nothing to brute-force
/// and nothing to rainbow-table, and a KDF here would only add milliseconds to every request
/// that authenticates. What matters instead is that the comparison is constant-time
/// (<see cref="Matches"/>) and that the stored value alone cannot authenticate.
/// </para>
/// </remarks>
public static class PersonalAccessTokenSecret
{
    /// <summary>The prefix a secret-scanning rule matches on.</summary>
    public const string Prefix = "nixpat_";

    /// <summary>The exact length of every presented token.</summary>
    public const int TokenLength = 62;

    private const int LookupLength = 12;
    private const int SecretBytes = 32;

    // Lowercase base32: unambiguous in logs, safe in URLs and shells, and visibly not the
    // base64url secret that follows it.
    private const string LookupAlphabet = "abcdefghijklmnopqrstuvwxyz234567";

    /// <summary>
    /// Mints a new token: the string shown to the caller exactly once, the lookup key stored in
    /// the clear, and the hash stored in its place.
    /// </summary>
    /// <returns>The minted token.</returns>
    public static MintedAccessToken Mint()
    {
        var lookup = RandomNumberGenerator.GetString(LookupAlphabet, LookupLength);
        var secret = Base64Url.EncodeToString(RandomNumberGenerator.GetBytes(SecretBytes));
        var token = $"{Prefix}{lookup}{secret}";

        return new MintedAccessToken(token, lookup, Hash(token));
    }

    /// <summary>
    /// Reads the lookup key out of a presented token, without vouching for the rest of it.
    /// </summary>
    /// <param name="presented">Whatever the caller sent.</param>
    /// <param name="lookup">The lookup key, when the shape is right.</param>
    /// <returns>
    /// Whether <paramref name="presented"/> has the shape of a token. A shape check only: the
    /// answer to "is it valid" is the hash comparison, never this.
    /// </returns>
    public static bool TryReadLookup(string? presented, out string lookup)
    {
        lookup = string.Empty;

        if (presented is null
            || presented.Length != TokenLength
            || !presented.StartsWith(Prefix, StringComparison.Ordinal))
        {
            return false;
        }

        var candidate = presented.AsSpan(Prefix.Length, LookupLength);
        foreach (var character in candidate)
        {
            if (!LookupAlphabet.Contains(character, StringComparison.Ordinal))
            {
                return false;
            }
        }

        lookup = new string(candidate);
        return true;
    }

    /// <summary>
    /// Hashes a presented token the way <see cref="Mint"/> hashed the original.
    /// </summary>
    /// <param name="token">The full token string, prefix included.</param>
    /// <returns>The SHA-256 of its UTF-8 bytes.</returns>
    /// <remarks>
    /// The whole string is hashed rather than only the secret half, so a stored hash can never be
    /// mistaken for the hash of anything but a Nix access token.
    /// </remarks>
    public static ReadOnlyMemory<byte> Hash(string token)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(token);
        return SHA256.HashData(Encoding.UTF8.GetBytes(token));
    }

    /// <summary>
    /// Compares a presented token against a stored hash, in constant time.
    /// </summary>
    /// <param name="storedHash">The hash kept when the token was minted.</param>
    /// <param name="presented">Whatever the caller sent.</param>
    /// <returns>Whether they match.</returns>
    public static bool Matches(ReadOnlyMemory<byte> storedHash, string presented)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(presented);
        return CryptographicOperations.FixedTimeEquals(
            storedHash.Span,
            Hash(presented).Span);
    }
}

/// <summary>A token fresh from the mint.</summary>
/// <param name="Token">The full secret string. Shown once, then only ever presented back.</param>
/// <param name="Lookup">The indexed half, stored in the clear.</param>
/// <param name="Hash">What is stored instead of the secret.</param>
public sealed record MintedAccessToken(
    string Token,
    string Lookup,
    ReadOnlyMemory<byte> Hash);
