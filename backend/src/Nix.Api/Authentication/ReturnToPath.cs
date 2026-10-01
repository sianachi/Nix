namespace Nix.Authentication;

/// <summary>
/// The one same-origin check every post-login and post-connect redirect passes through.
/// </summary>
/// <remarks>
/// A return path is attacker-influenced (a query string, a request body) and the browser follows
/// it after a successful sign-in or connection, so anything that could leave the origin is refused:
/// a scheme-relative <c>//host</c>, a backslash (which browsers normalise to a slash, so
/// <c>/\host</c> is <c>//host</c>), an absolute URL, and control characters.
/// </remarks>
public static class ReturnToPath
{
    /// <summary>The longest return path kept.</summary>
    public const int MaximumLength = 2048;

    /// <summary>Returns <paramref name="value"/> when it is a safe same-origin path, else <paramref name="fallback"/>.</summary>
    public static string Sanitize(string? value, string fallback = "/") =>
        IsSafe(value) ? value! : fallback;

    /// <summary>Whether <paramref name="value"/> is a safe same-origin path.</summary>
    public static bool IsSafe(string? value) =>
        value is { Length: > 0 and <= MaximumLength }
        && value[0] == '/'
        && (value.Length == 1 || value[1] != '/')
        && !value.Contains('\\', StringComparison.Ordinal)
        && !value.Any(char.IsControl);
}
