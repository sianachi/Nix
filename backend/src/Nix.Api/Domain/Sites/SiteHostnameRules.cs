using System.Security.Cryptography;

namespace Nix.Domain.Sites;

/// <summary>What one live DNS check of a custom hostname found.</summary>
/// <param name="Conclusive">False when the resolver could not answer; nothing then changes but the check time.</param>
/// <param name="TokenFound">Whether the verification TXT record holds the hostname's token.</param>
/// <param name="Error">A short code for what is wrong (<c>txt_missing</c>, <c>routing_missing</c>, ...), or null.</param>
public sealed record SiteHostnameCheck(bool Conclusive, bool TokenFound, string? Error)
{
    /// <summary>A check the resolver could not complete.</summary>
    public static SiteHostnameCheck Unavailable { get; } = new(false, false, "dns_unavailable");
}

/// <summary>How a check moved a hostname.</summary>
public enum SiteHostnameTransition
{
    /// <summary>Nothing that decides serving changed.</summary>
    Unchanged,

    /// <summary>The hostname was pending and is now verified: it starts being served.</summary>
    Verified,

    /// <summary>The hostname was verified and lost its record for too many checks in a row: it stops being served.</summary>
    Unverified,
}

/// <summary>
/// The pure rules of site hostnames (ADR-0063 M5): which are served, which one is canonical, how a
/// non-primary one answers, and the verification state machine. Nothing here reads DNS.
/// </summary>
public static class SiteHostnameRules
{
    /// <summary>A non-primary hostname that answers 200 with the same build and the primary's canonical links.</summary>
    public const string ServeMode = "serve";

    /// <summary>A non-primary hostname that answers 308 to the primary, keeping path and query.</summary>
    public const string RedirectMode = "redirect";

    /// <summary>Consecutive failed checks after which a verified hostname stops being served.</summary>
    public const int MaximumCheckFailures = 3;

    /// <summary>How long a claim may stay unverified before it is withdrawn.</summary>
    public static readonly TimeSpan PendingClaimLifetime = TimeSpan.FromDays(7);

    /// <summary>The shortest time between two checks a manager asks for.</summary>
    public static readonly TimeSpan CheckCooldown = TimeSpan.FromSeconds(60);

    /// <summary>The prefix of the verification TXT record name.</summary>
    public const string VerificationLabel = "_nix-site";

    /// <summary>The prefix of the verification TXT record value.</summary>
    public const string VerificationPrefix = "nix-site-verification=";

    /// <summary>Whether <paramref name="mode"/> names a serve mode.</summary>
    public static bool IsServeMode(string? mode) => mode is ServeMode or RedirectMode;

    /// <summary>A fresh per-claim verification token: 32 lowercase hex characters.</summary>
    public static string NewToken() => Convert.ToHexStringLower(RandomNumberGenerator.GetBytes(16));

    /// <summary>The name of the verification TXT record of <paramref name="hostname"/>.</summary>
    public static string VerificationName(string hostname) => VerificationLabel + "." + hostname;

    /// <summary>The value the verification TXT record must hold.</summary>
    public static string VerificationValue(string token) => VerificationPrefix + token;

    /// <summary>Whether a hostname gets a host manifest: a default one, or a custom one whose ownership is verified.</summary>
    public static bool IsServed(SiteHostname hostname)
    {
        ArgumentNullException.ThrowIfNull(hostname);
        return hostname.Kind == SiteRules.DefaultHost || hostname.VerifiedAt is not null;
    }

    /// <summary>
    /// The hostname canonical links point at: the site's primary when it is served, otherwise the
    /// default hostname. A pending primary never becomes canonical, so a page never names a host
    /// that does not answer.
    /// </summary>
    public static SiteHostname Canonical(string? primaryHostname, IEnumerable<SiteHostname> hostnames)
    {
        ArgumentNullException.ThrowIfNull(hostnames);
        var all = hostnames as IReadOnlyCollection<SiteHostname> ?? [.. hostnames];
        return all.FirstOrDefault(hostname => hostname.Hostname == primaryHostname && IsServed(hostname))
            ?? all.First(hostname => hostname.Kind == SiteRules.DefaultHost);
    }

    /// <summary>Whether a served hostname answers with a redirect to the canonical one.</summary>
    public static bool Redirects(SiteHostname hostname, SiteHostname canonical)
    {
        ArgumentNullException.ThrowIfNull(hostname);
        ArgumentNullException.ThrowIfNull(canonical);
        return hostname.ServeMode == RedirectMode && hostname.Hostname != canonical.Hostname;
    }

    /// <summary>
    /// Applies one check to a custom hostname. A found token verifies it (or keeps it verified and
    /// clears its failures). A missing token leaves a pending hostname pending; a verified one counts
    /// a failure and is unverified on the <see cref="MaximumCheckFailures"/>th in a row. An
    /// inconclusive check changes nothing but the check time and the error shown.
    /// </summary>
    /// <param name="hostname">The custom hostname, changed in place.</param>
    /// <param name="check">What the check found.</param>
    /// <param name="now">The check instant.</param>
    /// <returns>Whether serving changed.</returns>
    public static SiteHostnameTransition Apply(SiteHostname hostname, SiteHostnameCheck check, DateTimeOffset now)
    {
        ArgumentNullException.ThrowIfNull(hostname);
        ArgumentNullException.ThrowIfNull(check);
        if (hostname.Kind != SiteRules.CustomHost)
        {
            throw new InvalidOperationException("Only a custom hostname is checked.");
        }

        hostname.CheckedAt = now;
        hostname.CheckError = check.Error;
        if (!check.Conclusive)
        {
            return SiteHostnameTransition.Unchanged;
        }

        if (check.TokenFound)
        {
            hostname.CheckFailures = 0;
            if (hostname.VerifiedAt is not null)
            {
                return SiteHostnameTransition.Unchanged;
            }

            hostname.VerifiedAt = now;
            return SiteHostnameTransition.Verified;
        }

        if (hostname.VerifiedAt is null)
        {
            return SiteHostnameTransition.Unchanged;
        }

        hostname.CheckFailures = Math.Min(hostname.CheckFailures + 1, MaximumCheckFailures);
        if (hostname.CheckFailures < MaximumCheckFailures)
        {
            return SiteHostnameTransition.Unchanged;
        }

        hostname.VerifiedAt = null;
        hostname.CheckFailures = 0;
        return SiteHostnameTransition.Unverified;
    }

    /// <summary>Whether a claim was never verified within <see cref="PendingClaimLifetime"/>; it is then withdrawn, not checked.</summary>
    public static bool IsAbandoned(DateTimeOffset createdAt, DateTimeOffset? verifiedAt, DateTimeOffset now) =>
        verifiedAt is null && now - createdAt >= PendingClaimLifetime;

    /// <summary>
    /// When a custom hostname is next looked at in the background: soon while it is pending, soon
    /// while a verified one is failing, a few times a day otherwise, and once its claim has run out
    /// (at which point it is withdrawn).
    /// </summary>
    public static DateTimeOffset NextCheck(DateTimeOffset createdAt, DateTimeOffset? verifiedAt, DateTimeOffset? checkedAt, int failures)
    {
        if (checkedAt is not { } last)
        {
            return createdAt;
        }

        if (verifiedAt is null)
        {
            var next = last + TimeSpan.FromMinutes(5);
            var expiry = createdAt + PendingClaimLifetime;
            return next < expiry ? next : expiry;
        }

        return last + (failures > 0 ? TimeSpan.FromMinutes(10) : TimeSpan.FromHours(6));
    }
}
