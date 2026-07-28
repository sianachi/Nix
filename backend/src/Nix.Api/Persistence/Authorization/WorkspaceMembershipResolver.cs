using Nix.Abstractions;
using Nix.Domain.Authorization;
using Nix.Domain.Tenancy;
using Nix.Persistence.Sql;
using Nix.Persistence.Sql.Statements;
using Npgsql;
using NpgsqlTypes;

namespace Nix.Persistence.Authorization;

/// <summary>
/// Resolves permissions from workspace membership: a member by name, a member through a group, or a
/// tenant administrator.
/// </summary>
/// <remarks>
/// <para>
/// The first implementation of the authorization port, and a real one — it reads
/// <c>workspace_member</c>, <c>group_membership</c> and <c>tenant_role</c> against live rows rather
/// than standing in for something later. Before it existed nothing in the system read any of those
/// tables at runtime, which meant any authenticated principal could reach every workspace in their
/// tenant. Row-level security was isolating tenants from each other and nothing else.
/// </para>
/// <para>
/// Access control entries replace this class and keep the port. What changes then is granularity:
/// the answer becomes per item rather than per workspace, and the filtering moves inside the item
/// query because the two stop being equivalent.
/// </para>
/// <para>
/// <b>Answers are memoised for the unit of work.</b> A scope is one request and one tenant, and the
/// rows behind the answer cannot change underneath it — the transaction that would change them is
/// this one. Listing an item's children therefore asks the database once rather than once per item, which is
/// the difference between a page of two hundred children costing one round trip and costing two
/// hundred.
/// </para>
/// </remarks>
public sealed class WorkspaceMembershipResolver : IPermissionResolver
{
    private readonly NixSqlExecutor _sql;
    private readonly INixSessionContextAccessor _session;
    private readonly Dictionary<WorkspaceId, WorkspaceRole?> _roles = [];

    private bool? _isAdministrator;

    /// <summary>
    /// Initializes a new instance of the <see cref="WorkspaceMembershipResolver"/> class.
    /// </summary>
    /// <param name="sql">The executor sharing this unit of work's connection and transaction.</param>
    /// <param name="session">The tenant and principal this request runs as.</param>
    public WorkspaceMembershipResolver(NixSqlExecutor sql, INixSessionContextAccessor session)
    {
        ArgumentNullException.ThrowIfNull(sql);
        ArgumentNullException.ThrowIfNull(session);

        _sql = sql;
        _session = session;
    }

    private NixSessionContext Session => _session.Current
        ?? throw new InvalidOperationException(
            "No session context has been established for this unit of work. Every authorization "
            + "question is asked on behalf of a specific principal in a specific tenant; there is "
            + "no anonymous path.");

    /// <inheritdoc />
    public async ValueTask<bool> CanReadWorkspaceAsync(
        WorkspaceId workspaceId,
        CancellationToken cancellationToken)
    {
        var role = await RoleInAsync(workspaceId, cancellationToken).ConfigureAwait(false);
        return role is not null;
    }

    /// <inheritdoc />
    public async ValueTask<bool> CanWriteWorkspaceAsync(
        WorkspaceId workspaceId,
        CancellationToken cancellationToken)
    {
        var role = await RoleInAsync(workspaceId, cancellationToken).ConfigureAwait(false);
        return role is { } held && held.GrantsWrite();
    }

    /// <inheritdoc />
    public async ValueTask<bool> IsTenantAdministratorAsync(CancellationToken cancellationToken)
    {
        if (_isAdministrator is { } cached)
        {
            return cached;
        }

        var context = Session;
        var answer = await _sql.ScalarOrDefaultAsync<bool>(
            AuthorizationSql.PrincipalIsTenantAdministrator,
            [
                Uuid("tenant_id", context.TenantId.Value),
                Uuid("principal_id", context.PrincipalId.Value),
            ],
            cancellationToken).ConfigureAwait(false);

        _isAdministrator = answer;
        return answer;
    }

    /// <summary>
    /// The strongest role the acting principal holds in a workspace, or <see langword="null"/> when
    /// they hold none.
    /// </summary>
    /// <remarks>
    /// A tenant administrator is treated as an owner of every workspace in the tenant, which is what
    /// the role is for: an administrator who could be locked out of a workspace could not administer
    /// the tenant. It is resolved second so that an ordinary member costs one query rather than two.
    /// </remarks>
    private async ValueTask<WorkspaceRole?> RoleInAsync(
        WorkspaceId workspaceId,
        CancellationToken cancellationToken)
    {
        if (_roles.TryGetValue(workspaceId, out var cached))
        {
            return cached;
        }

        var context = Session;
        WorkspaceRole? strongest = null;

        var rows = _sql.QueryAsync<string, RoleTextMapper>(
            AuthorizationSql.WorkspaceRolesForPrincipal,
            default,
            [
                Uuid("tenant_id", context.TenantId.Value),
                Uuid("workspace_id", workspaceId.Value),
                Uuid("principal_id", context.PrincipalId.Value),
            ],
            cancellationToken);

        await foreach (var text in rows.ConfigureAwait(false))
        {
            // Unrecognised role text is skipped rather than thrown on: a database written by a
            // newer build must leave this one refusing grants it cannot interpret, not failing
            // every request that touches the workspace.
            if (WorkspaceRoles.TryParse(text, out var role) && (strongest is null || role > strongest))
            {
                strongest = role;
            }
        }

        if (strongest is null
            && await IsTenantAdministratorAsync(cancellationToken).ConfigureAwait(false))
        {
            strongest = WorkspaceRole.Owner;
        }

        _roles[workspaceId] = strongest;
        return strongest;
    }

    private static NpgsqlParameter Uuid(string name, Guid value) =>
        new(name, NpgsqlDbType.Uuid) { Value = value };

    /// <summary>Reads the single <c>role</c> column.</summary>
    /// <remarks>
    /// A struct so the query loop devirtualises and allocates nothing per row beyond the string
    /// itself.
    /// </remarks>
    private readonly struct RoleTextMapper : INixRowMapper<string>
    {
        /// <inheritdoc />
        public string Map(NpgsqlDataReader reader)
        {
            ArgumentNullException.ThrowIfNull(reader);
            return reader.GetString(0);
        }
    }
}
