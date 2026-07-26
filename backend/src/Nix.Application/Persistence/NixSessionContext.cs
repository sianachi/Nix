namespace Nix.Application.Persistence;

/// <summary>
/// The tenant scope a unit of work runs under. Infrastructure publishes it to Postgres as
/// transaction-local session settings (<c>nix.tenant_id</c>, <c>nix.workspace_id</c>,
/// <c>nix.principal_id</c>) that the row-level security policies read.
/// </summary>
/// <remarks>
/// <para>
/// This type carries no EF Core or Npgsql dependency on purpose: the port lives in
/// <c>Nix.Application</c>, the implementation in <c>Nix.Infrastructure</c>.
/// </para>
/// <para>
/// Identifiers are <see cref="Guid"/> today because no domain schema exists yet. The tenancy
/// goal introduces the typed identity structs (<c>TenantId</c>, <c>WorkspaceId</c>,
/// <c>PrincipalId</c>) in <c>Nix.Core</c>; when it does, these members change type and nothing
/// else about the mechanism moves.
/// </para>
/// <para>
/// The values are never trusted from a client. They come from the validated token and the
/// resolved principal, which is why this record is constructed only by the request pipeline.
/// </para>
/// </remarks>
/// <param name="TenantId">The tenant every row touched by the unit of work must belong to.</param>
/// <param name="WorkspaceId">
/// The workspace in scope, or <see langword="null"/> for tenant-wide work (listing workspaces,
/// tenant administration, background jobs that span workspaces). Never a substitute for
/// <paramref name="TenantId"/>: absence narrows nothing.
/// </param>
/// <param name="PrincipalId">The acting principal, used by policies and by the audit trail.</param>
public readonly record struct NixSessionContext(Guid TenantId, Guid? WorkspaceId, Guid PrincipalId)
{
    /// <summary>
    /// Creates a tenant-wide context with no workspace in scope.
    /// </summary>
    /// <param name="tenantId">The tenant in scope.</param>
    /// <param name="principalId">The acting principal.</param>
    /// <returns>A context whose <see cref="WorkspaceId"/> is <see langword="null"/>.</returns>
    public static NixSessionContext ForTenant(Guid tenantId, Guid principalId) =>
        new(tenantId, WorkspaceId: null, principalId);

    /// <summary>
    /// Gets a value indicating whether this context identifies a real tenant and principal.
    /// An all-empty context is the uninitialised value and must never reach the database:
    /// publishing it would set the session variables to the nil UUID, which reads as a tenant
    /// rather than as "no tenant".
    /// </summary>
    public bool IsComplete => TenantId != Guid.Empty && PrincipalId != Guid.Empty;
}
