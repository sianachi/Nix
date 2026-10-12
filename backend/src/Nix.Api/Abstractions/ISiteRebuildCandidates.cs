using Nix.Domain.Identity;
using Nix.Domain.Tenancy;

namespace Nix.Abstractions;

/// <summary>A published site in automatic mode whose subtree changed after its live build was requested.</summary>
/// <param name="TenantId">The site's tenant.</param>
/// <param name="WorkspaceId">The site's workspace.</param>
/// <param name="SiteId">The site.</param>
/// <param name="PrincipalId">The principal who turned automatic republish on, whom the rebuild runs as.</param>
/// <param name="FireAt">The last change plus the site's debounce, never earlier than the instant asked from.</param>
/// <param name="ChangedAt">The most recent change inside the subtree: an edit, a move to the trash, or a lock.</param>
/// <param name="Failures">Automatic builds that failed since the live one; each doubles the wait before the next try.</param>
public sealed record SiteRebuildCandidate(
    TenantId TenantId,
    WorkspaceId WorkspaceId,
    Guid SiteId,
    PrincipalId PrincipalId,
    DateTimeOffset FireAt,
    DateTimeOffset ChangedAt,
    int Failures);

/// <summary>
/// Cross-tenant discovery for automatic republish, backed by the SECURITY DEFINER function
/// <c>nix_site_rebuild_candidates</c> in <c>SitesSecuritySql</c> - the only cross-tenant reader the
/// feature needs, exactly as <see cref="Scheduling.IReminderCandidateFinder"/> is for reminders.
/// Called from <c>ITriggerSource.PlanAsync</c>, which runs with no session established yet.
/// </summary>
public interface ISiteRebuildCandidates
{
    /// <summary>Finds changed automatic sites, soonest first.</summary>
    /// <param name="notBefore">Raises every <see cref="SiteRebuildCandidate.FireAt"/> to at least this instant.</param>
    /// <param name="limit">At most 500.</param>
    /// <param name="cancellationToken">Cancels the read.</param>
    /// <returns>The candidates.</returns>
    public Task<IReadOnlyList<SiteRebuildCandidate>> FindAsync(DateTimeOffset notBefore, int limit, CancellationToken cancellationToken);
}
