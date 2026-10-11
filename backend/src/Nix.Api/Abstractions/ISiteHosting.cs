using System.Text.Json.Nodes;
using Nix.Domain.Identity;
using Nix.Domain.Sites;
using Nix.Domain.Tenancy;

namespace Nix.Abstractions;

/// <summary>The resolver could not answer: a timeout, a refused request or a malformed reply.</summary>
public sealed class SiteDnsUnavailableException : Exception
{
    /// <summary>Creates the exception.</summary>
    public SiteDnsUnavailableException()
    {
    }

    /// <summary>Creates the exception with a message.</summary>
    public SiteDnsUnavailableException(string message)
        : base(message)
    {
    }

    /// <summary>Creates the exception with a message and its cause.</summary>
    public SiteDnsUnavailableException(string message, Exception innerException)
        : base(message, innerException)
    {
    }
}

/// <summary>
/// Looks up public DNS records for hostname verification. Only names are sent; nothing a manager
/// typed is ever fetched as a URL. Implementations bound every lookup with a timeout.
/// </summary>
public interface ISiteDnsResolver
{
    /// <summary>The record data of <paramref name="name"/> for <paramref name="type"/>; empty when none exist.</summary>
    /// <param name="name">A hostname.</param>
    /// <param name="type"><c>TXT</c>, <c>A</c>, <c>AAAA</c> or <c>CNAME</c>.</param>
    /// <param name="cancellationToken">Cancels the lookup.</param>
    /// <returns>The data of each answer of that type; TXT strings are unquoted and joined.</returns>
    /// <exception cref="SiteDnsUnavailableException">The resolver could not answer.</exception>
    public Task<IReadOnlyList<string>> QueryAsync(string name, string type, CancellationToken cancellationToken);
}

/// <summary>A DNS record in a Cloudflare zone.</summary>
/// <param name="Id">The record id.</param>
/// <param name="Type">The record type.</param>
/// <param name="Name">The full record name.</param>
/// <param name="Content">The record content.</param>
/// <param name="Proxied">Whether Cloudflare proxies it.</param>
/// <param name="Comment">The record comment; Nix tags its own records here.</param>
public sealed record CloudflareDnsRecord(string Id, string Type, string Name, string Content, bool Proxied, string? Comment);

/// <summary>A record to create or replace.</summary>
/// <param name="Type">The record type.</param>
/// <param name="Name">The full record name.</param>
/// <param name="Content">The record content.</param>
/// <param name="Proxied">Whether Cloudflare proxies it (never for TXT).</param>
/// <param name="Comment">The tag naming Nix and the site.</param>
public sealed record CloudflareDnsRecordInput(string Type, string Name, string Content, bool Proxied, string Comment);

/// <summary>The Cloudflare API refused or failed a call.</summary>
public sealed class CloudflareApiException : Exception
{
    /// <summary>Creates the exception.</summary>
    public CloudflareApiException()
    {
    }

    /// <summary>Creates the exception with a message.</summary>
    public CloudflareApiException(string message)
        : base(message)
    {
    }

    /// <summary>Creates the exception with a message and its cause.</summary>
    public CloudflareApiException(string message, Exception innerException)
        : base(message, innerException)
    {
    }
}

/// <summary>
/// The slice of the Cloudflare API hostname automation needs: zone lookup, DNS record CRUD, and the
/// configuration of one remotely managed tunnel. Implemented over HTTP with the operator's token,
/// and in memory for tests.
/// </summary>
public interface ICloudflareDns
{
    /// <summary>The id of the zone named <paramref name="zoneName"/> in the configured account, or null.</summary>
    public Task<string?> FindZoneIdAsync(string zoneName, CancellationToken cancellationToken);

    /// <summary>Every record named exactly <paramref name="name"/> in the zone.</summary>
    public Task<IReadOnlyList<CloudflareDnsRecord>> ListRecordsAsync(string zoneId, string name, CancellationToken cancellationToken);

    /// <summary>Creates a record.</summary>
    public Task<CloudflareDnsRecord> CreateRecordAsync(string zoneId, CloudflareDnsRecordInput record, CancellationToken cancellationToken);

    /// <summary>Replaces a record's type, content, proxying and comment.</summary>
    public Task<CloudflareDnsRecord> UpdateRecordAsync(string zoneId, string recordId, CloudflareDnsRecordInput record, CancellationToken cancellationToken);

    /// <summary>Deletes a record; an absent one is not an error.</summary>
    public Task DeleteRecordAsync(string zoneId, string recordId, CancellationToken cancellationToken);

    /// <summary>The tunnel's whole configuration object (<c>result.config</c>), so a write keeps every other setting.</summary>
    public Task<JsonObject> GetTunnelConfigAsync(CancellationToken cancellationToken);

    /// <summary>Replaces the tunnel's configuration.</summary>
    public Task PutTunnelConfigAsync(JsonObject config, CancellationToken cancellationToken);
}

/// <summary>A custom hostname due for a background DNS check.</summary>
/// <param name="TenantId">The site's tenant.</param>
/// <param name="WorkspaceId">The site's workspace.</param>
/// <param name="SiteId">The site.</param>
/// <param name="PrincipalId">The site's creator, whom the check's session runs as.</param>
/// <param name="Hostname">The hostname.</param>
/// <param name="CreatedAt">When it was added.</param>
/// <param name="VerifiedAt">When it was verified, if it is.</param>
/// <param name="CheckedAt">When it was last checked, if ever.</param>
/// <param name="CheckFailures">Failed checks in a row while verified.</param>
public sealed record SiteHostnameCheckCandidate(
    TenantId TenantId,
    WorkspaceId WorkspaceId,
    Guid SiteId,
    PrincipalId PrincipalId,
    string Hostname,
    DateTimeOffset CreatedAt,
    DateTimeOffset? VerifiedAt,
    DateTimeOffset? CheckedAt,
    int CheckFailures);

/// <summary>
/// Cross-tenant discovery of custom hostnames to re-check, backed by the SECURITY DEFINER function
/// <c>nix_site_hostname_checks</c>. Called from <c>ITriggerSource.PlanAsync</c> with no session.
/// </summary>
public interface ISiteHostnameCheckCandidates
{
    /// <summary>Custom hostnames, least recently checked first.</summary>
    /// <param name="limit">At most 500.</param>
    /// <param name="cancellationToken">Cancels the read.</param>
    /// <returns>The candidates.</returns>
    public Task<IReadOnlyList<SiteHostnameCheckCandidate>> FindAsync(int limit, CancellationToken cancellationToken);
}

/// <summary>Hostname and approval storage for sites, inside the current unit of work.</summary>
public interface ISiteHostnameStore
{
    /// <summary>The hostnames of a site, tracked for update.</summary>
    public ValueTask<List<SiteHostname>> LoadForUpdateAsync(Guid siteId, CancellationToken cancellationToken);

    /// <summary>Starts tracking a new hostname.</summary>
    public void Add(SiteHostname hostname);

    /// <summary>Stops tracking and deletes a hostname.</summary>
    public void Remove(SiteHostname hostname);

    /// <summary>
    /// Writes everything tracked. A verified hostname another site already serves is refused by the
    /// global index; the write is then rolled back to a savepoint, the change tracker is cleared,
    /// and false is returned.
    /// </summary>
    public ValueTask<bool> TrySaveAsync(CancellationToken cancellationToken);

    /// <summary>The sites of the current tenant waiting for an operator, oldest request first.</summary>
    public ValueTask<IReadOnlyList<Site>> ListPendingApprovalsAsync(CancellationToken cancellationToken);

    /// <summary>Marks a point the unit of work can return to with <see cref="RevertToMarkAsync"/>.</summary>
    public ValueTask MarkAsync(CancellationToken cancellationToken);

    /// <summary>Undoes every write since <see cref="MarkAsync"/> and forgets every tracked entity.</summary>
    public ValueTask RevertToMarkAsync(CancellationToken cancellationToken);
}

/// <summary>
/// Serialises edits of the one Cloudflare tunnel configuration: it is read, changed and written
/// whole, so two hostname changes at once would otherwise lose one of them.
/// </summary>
public interface ISiteTunnelLock
{
    /// <summary>Holds the tunnel lock until the current transaction ends.</summary>
    public ValueTask LockAsync(CancellationToken cancellationToken);
}
