using Nix.Core.Tenancy;

namespace Nix.Application.Authorization;

/// <summary>
/// Decides what the acting principal may do. The single authorization code path.
/// </summary>
/// <remarks>
/// <para>
/// <b>One port, one implementation at a time, and every read goes through it.</b> The value of this
/// interface is not that it might be swapped — it is that there is exactly one place the question
/// is answered, so a change to the rules cannot leave one endpoint deciding differently from
/// another. A use case that reaches around it is a bug even when the answer happens to be right.
/// </para>
/// <para>
/// <b>Today's implementation resolves workspace membership.</b> A principal may act in a workspace
/// if they are a member of it, directly or through a group, or if they hold a tenant-wide
/// administrative role. That is the whole rule, and it is a real check against real rows rather
/// than a placeholder.
/// </para>
/// <para>
/// <b>Item-level access control replaces the implementation, not the port.</b> When access control
/// entries arrive with their precedence order — an explicit deny anywhere in the chain refuses,
/// otherwise the nearest entry by closure depth wins, ties break towards a principal over a group,
/// inheritance can be broken, the workspace role is the chain-root allow, and a tenant administrator
/// may override but is always audited — the answer becomes per item and the filtering moves into
/// the item query itself. Nothing above this interface changes.
/// </para>
/// <para>
/// While the unit of visibility is the whole workspace, asking once before a query and filtering
/// inside it come to the same thing: either every item in the workspace is visible or none is.
/// That equivalence stops holding the moment entries are per item, which is why the port is shaped
/// around a decision rather than around a boolean anyone might cache.
/// </para>
/// </remarks>
public interface IPermissionResolver
{
    /// <summary>
    /// Whether the acting principal may read a workspace and the items in it.
    /// </summary>
    /// <param name="workspaceId">The workspace.</param>
    /// <param name="cancellationToken">Cancels the lookup.</param>
    /// <returns><see langword="true"/> when the workspace may be read.</returns>
    /// <remarks>
    /// A workspace the principal may not read is reported by callers as not found, never as
    /// forbidden: "you may not see this" confirms the thing exists, which is how an outsider
    /// enumerates a tenant one identifier at a time.
    /// </remarks>
    public ValueTask<bool> CanReadWorkspaceAsync(WorkspaceId workspaceId, CancellationToken cancellationToken);

    /// <summary>
    /// Whether the acting principal may create, change or remove items in a workspace.
    /// </summary>
    /// <param name="workspaceId">The workspace.</param>
    /// <param name="cancellationToken">Cancels the lookup.</param>
    /// <returns><see langword="true"/> when the workspace may be written to.</returns>
    /// <remarks>
    /// Separate from reading even though membership currently grants both, because the moment roles
    /// carry meaning a reader is not an editor — and a call site that asked the wrong question
    /// would then be wrong silently. Asking the question you mean costs nothing now and is correct
    /// later.
    /// </remarks>
    public ValueTask<bool> CanWriteWorkspaceAsync(WorkspaceId workspaceId, CancellationToken cancellationToken);

    /// <summary>
    /// Whether the acting principal holds a tenant-wide administrative role.
    /// </summary>
    /// <param name="cancellationToken">Cancels the lookup.</param>
    /// <returns><see langword="true"/> when the principal is a tenant administrator.</returns>
    /// <remarks>
    /// Read from the database on every request rather than from a token claim. Roles live in the
    /// database and never in tokens: a role inside a bearer artefact minted minutes ago by a system
    /// we do not control cannot be revoked before it expires.
    /// </remarks>
    public ValueTask<bool> IsTenantAdministratorAsync(CancellationToken cancellationToken);
}
