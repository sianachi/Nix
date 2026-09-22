using System.Globalization;
using System.Security.Cryptography;
using System.Text;

namespace Nix.Features.Locks;

/// <summary>
/// Derives and checks item-lock password verifiers.
/// </summary>
/// <remarks>
/// <para>
/// PBKDF2-HMAC-SHA256 at 600,000 iterations with a 128-bit salt: the current OWASP recommendation
/// for that construction, and in the base class library, so the verifier needs no new dependency.
/// A verify costs a few hundred milliseconds of one core, which is the point for somebody guessing
/// and the reason the unlock route carries its own rate limit.
/// </para>
/// <para>
/// The stored form names its algorithm and iteration count, so raising the cost later does not
/// invalidate a verifier already stored: an old one keeps checking at the cost it was made with.
/// </para>
/// </remarks>
public static class LockPasswordHasher
{
    /// <summary>The shortest password a lock accepts.</summary>
    public const int MinimumLength = 4;

    /// <summary>The longest password a lock accepts, bounding the work one request can ask for.</summary>
    public const int MaximumLength = 256;

    private const string Scheme = "pbkdf2-sha256";
    private const int Iterations = 600_000;
    private const int SaltBytes = 16;
    private const int HashBytes = 32;

    /// <summary>Whether a candidate password is within the accepted length.</summary>
    /// <param name="password">The candidate.</param>
    /// <returns><see langword="true"/> when it may be set or checked.</returns>
    public static bool IsAcceptable(string? password) =>
        password is not null
        && password.Length >= MinimumLength
        && password.Length <= MaximumLength;

    /// <summary>Derives a verifier for a new password.</summary>
    /// <param name="password">The password, already checked with <see cref="IsAcceptable"/>.</param>
    /// <returns>The self-describing verifier to store.</returns>
    public static string Hash(string password)
    {
        ArgumentNullException.ThrowIfNull(password);

        var salt = RandomNumberGenerator.GetBytes(SaltBytes);
        var hash = Derive(password, salt, Iterations);

        return string.Create(
            CultureInfo.InvariantCulture,
            $"{Scheme}${Iterations}${Convert.ToBase64String(salt)}${Convert.ToBase64String(hash)}");
    }

    /// <summary>Checks a password against a stored verifier in constant time.</summary>
    /// <param name="password">The presented password.</param>
    /// <param name="verifier">The stored verifier.</param>
    /// <returns><see langword="true"/> when the password matches.</returns>
    /// <remarks>
    /// A malformed verifier answers <see langword="false"/> rather than throwing: it can only come
    /// from a defect, and failing closed is the right answer to a lock nobody can check.
    /// </remarks>
    public static bool Verify(string password, string verifier)
    {
        ArgumentNullException.ThrowIfNull(password);
        ArgumentNullException.ThrowIfNull(verifier);

        if (password.Length > MaximumLength)
        {
            return false;
        }

        var parts = verifier.Split('$');
        if (parts.Length != 4
            || !string.Equals(parts[0], Scheme, StringComparison.Ordinal)
            || !int.TryParse(parts[1], NumberStyles.None, CultureInfo.InvariantCulture, out var iterations)
            || iterations < 1)
        {
            return false;
        }

        byte[] salt;
        byte[] expected;
        try
        {
            salt = Convert.FromBase64String(parts[2]);
            expected = Convert.FromBase64String(parts[3]);
        }
        catch (FormatException)
        {
            return false;
        }

        if (salt.Length == 0 || expected.Length == 0)
        {
            return false;
        }

        var actual = Derive(password, salt, iterations, expected.Length);
        return CryptographicOperations.FixedTimeEquals(actual, expected);
    }

    private static byte[] Derive(string password, byte[] salt, int iterations, int length = HashBytes) =>
        Rfc2898DeriveBytes.Pbkdf2(
            Encoding.UTF8.GetBytes(password),
            salt,
            iterations,
            HashAlgorithmName.SHA256,
            length);
}
