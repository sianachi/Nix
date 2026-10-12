using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using Nix.Abstractions;
using Nix.Abstractions.Scheduling;
using Nix.Domain.Scheduling;
using Nix.Domain.Sites;

namespace Nix.Features.Sites;

/// <summary>
/// Re-checks custom hostnames in the background: a pending one is verified once its TXT record
/// appears, and a verified one whose record has gone for <see cref="SiteHostnameRules.MaximumCheckFailures"/>
/// checks in a row stops being served (audited, host manifest deleted).
/// </summary>
/// <remarks>
/// Planning crosses tenants through <c>nix_site_hostname_checks</c> (identifiers, hostnames and
/// instants only). Firing runs in the dispatcher's transaction scoped to the site's tenant and
/// creator; the check itself is a DNS lookup with a timeout, and it needs no one's permission
/// because it only reads public DNS and writes the hostname's own verification state.
/// </remarks>
public sealed class SiteHostnameCheckTriggerSource(
    ISiteHostnameCheckCandidates candidates,
    ISiteStore sites,
    SiteHostnameService service,
    TimeProvider clock) : ITriggerSource
{
    public const string SourceName = "site.hostname_check";

    private const int PageSize = 500;
    private const string KeyPrefix = SourceName + ":";

    /// <inheritdoc />
    public string Name => SourceName;

    /// <inheritdoc />
    public TriggerKind Kind => TriggerKind.System;

    /// <inheritdoc />
    public async Task<TriggerPlan> PlanAsync(PlanWindow window, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(window);
        var found = await candidates.FindAsync(PageSize, cancellationToken).ConfigureAwait(false);
        var desired = new List<DesiredTrigger>(found.Count);
        foreach (var candidate in found)
        {
            var due = SiteHostnameRules.NextCheck(candidate.CreatedAt, candidate.VerifiedAt, candidate.CheckedAt, candidate.CheckFailures);
            var fireAt = due < window.Start ? window.Start : due;
            if (fireAt >= window.End)
            {
                continue;
            }

            // The last check instant is in the key, so each check plans exactly one next one.
            desired.Add(new DesiredTrigger(
                candidate.TenantId,
                candidate.WorkspaceId,
                candidate.PrincipalId,
                SourceItemId: null,
                RuleId: null,
                fireAt,
                Key(candidate.SiteId, candidate.Hostname, candidate.CheckedAt)));
        }

        return new TriggerPlan(desired, Complete: found.Count < PageSize);
    }

    /// <inheritdoc />
    public async Task<TriggerOutcome> FireAsync(DueTrigger trigger, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(trigger);
        if (!TryRead(trigger.DedupeKey, out var siteId, out var digest))
        {
            return TriggerOutcome.Skipped("malformed_key");
        }

        // Read without the site lock: the service looks DNS up first and locks only to write.
        var hostname = (await sites.ListHostnamesAsync([siteId], cancellationToken).ConfigureAwait(false))
            .FirstOrDefault(row => row.Kind == SiteRules.CustomHost && Digest(row.Hostname) == digest);
        if (hostname is null)
        {
            return TriggerOutcome.Skipped("hostname_gone");
        }

        var result = SiteHostnameRules.IsAbandoned(hostname.CreatedAt, hostname.VerifiedAt, clock.GetUtcNow())
            ? await service.ExpireAsync(siteId, hostname.Hostname, cancellationToken).ConfigureAwait(false)
            : await service.CheckAsync(siteId, hostname.Hostname, background: true, cancellationToken).ConfigureAwait(false);
        return result.Reason is "raced" or "hostname_gone" or "activation_raced" or "dns_cleanup_failed"
            ? TriggerOutcome.Skipped(result.Reason)
            : TriggerOutcome.Fired("hostname_" + result.Reason);
    }

    /// <summary>The dedupe key of one check: site, a digest of the hostname (names can outgrow the key), and the previous check.</summary>
    public static string Key(Guid siteId, string hostname, DateTimeOffset? checkedAt) =>
        KeyPrefix + siteId.ToString("N") + ":" + Digest(hostname) + ":"
        + (checkedAt?.ToUnixTimeMilliseconds() ?? 0).ToString(CultureInfo.InvariantCulture);

    private static string Digest(string hostname) => Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(hostname)))[..16];

    private static bool TryRead(string dedupeKey, out Guid siteId, out string digest)
    {
        siteId = Guid.Empty;
        digest = string.Empty;
        if (!dedupeKey.StartsWith(KeyPrefix, StringComparison.Ordinal))
        {
            return false;
        }

        var parts = dedupeKey[KeyPrefix.Length..].Split(':');
        if (parts.Length != 3 || parts[1].Length != 16 || !Guid.TryParseExact(parts[0], "N", out siteId))
        {
            return false;
        }

        digest = parts[1];
        return true;
    }
}
