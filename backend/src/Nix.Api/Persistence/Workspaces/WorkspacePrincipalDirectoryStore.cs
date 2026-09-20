using Nix.Abstractions;
using Nix.Domain.Identity;
using Nix.Domain.Tenancy;
using Nix.Persistence.Sql;
using Npgsql;
using NpgsqlTypes;

namespace Nix.Persistence.Workspaces;

/// <summary>One active principal with effective membership in a readable workspace.</summary>
public sealed record WorkspacePrincipalSnapshot(PrincipalId PrincipalId, string DisplayName, string Kind);

/// <summary>Resolves active direct and group-derived workspace principals for assignment controls.</summary>
public sealed class WorkspacePrincipalDirectoryStore(
    NixSqlExecutor sql,
    IPermissionResolver permissions,
    INixSessionContextAccessor session)
{
    public async ValueTask<IReadOnlyList<WorkspacePrincipalSnapshot>> ListAsync(
        WorkspaceId workspaceId,
        string? search,
        PrincipalId? afterPrincipalId,
        int limit,
        CancellationToken cancellationToken)
    {
        var context = session.Current
            ?? throw new InvalidOperationException("No session context was established for workspace principal search.");
        if (!await permissions.CanReadWorkspaceAsync(workspaceId, cancellationToken).ConfigureAwait(false))
        {
            return [];
        }

        var rows = new List<WorkspacePrincipalSnapshot>(limit);
        var query = sql.QueryAsync<WorkspacePrincipalSnapshot, WorkspacePrincipalMapper>(
            WorkspacePrincipalDirectorySql.List,
            default,
            [
                Uuid("tenant_id", context.TenantId.Value),
                Uuid("workspace_id", workspaceId.Value),
                UuidOrNull("after_principal_id", afterPrincipalId?.Value),
                TextOrNull("query", search),
                Integer("limit", limit),
            ],
            cancellationToken);
        await foreach (var row in query.ConfigureAwait(false))
        {
            rows.Add(row);
        }
        return rows;
    }

    private static NpgsqlParameter Uuid(string name, Guid value) =>
        new(name, NpgsqlDbType.Uuid) { Value = value };

    private static NpgsqlParameter UuidOrNull(string name, Guid? value) =>
        new(name, NpgsqlDbType.Uuid) { Value = value is { } actual ? actual : DBNull.Value };

    private static NpgsqlParameter TextOrNull(string name, string? value) =>
        new(name, NpgsqlDbType.Text) { Value = value is null ? DBNull.Value : value };

    private static NpgsqlParameter Integer(string name, int value) =>
        new(name, NpgsqlDbType.Integer) { Value = value };

    private readonly struct WorkspacePrincipalMapper : INixRowMapper<WorkspacePrincipalSnapshot>
    {
        public WorkspacePrincipalSnapshot Map(NpgsqlDataReader reader) => new(
            PrincipalId.From(reader.GetGuid(0)),
            reader.GetString(1),
            reader.GetString(2));
    }
}

public static class WorkspacePrincipalDirectorySql
{
    public const string List = """
        SELECT principal.principal_id, principal.display_name, principal.kind
        FROM principal
        WHERE principal.tenant_id = @tenant_id
          AND principal.status = 'active'
          AND (@after_principal_id IS NULL OR principal.principal_id > @after_principal_id)
          AND (@query IS NULL OR position(lower(@query) in lower(principal.display_name)) > 0)
          AND (
              EXISTS (
                  SELECT 1
                  FROM workspace_member direct_member
                  WHERE direct_member.tenant_id = @tenant_id
                    AND direct_member.workspace_id = @workspace_id
                    AND direct_member.subject_type = 'principal'
                    AND direct_member.subject_id = principal.principal_id)
              OR EXISTS (
                  SELECT 1
                  FROM workspace_member group_member
                  JOIN principal_group granted_group
                    ON granted_group.tenant_id = group_member.tenant_id
                   AND granted_group.group_id = group_member.subject_id
                  JOIN group_membership membership
                    ON membership.tenant_id = group_member.tenant_id
                   AND membership.group_id = granted_group.group_id
                   AND membership.principal_id = principal.principal_id
                  WHERE group_member.tenant_id = @tenant_id
                    AND group_member.workspace_id = @workspace_id
                    AND group_member.subject_type = 'group'))
        ORDER BY principal.principal_id
        LIMIT @limit
        """;
}
