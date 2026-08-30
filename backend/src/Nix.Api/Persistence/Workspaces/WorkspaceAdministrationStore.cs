using Nix.Abstractions;
using Nix.Domain.Identity;
using Nix.Domain.Provisioning;
using Nix.Domain.Tenancy;
using Nix.Persistence.Sql;
using Nix.Persistence.Sql.Statements;
using Npgsql;
using NpgsqlTypes;

namespace Nix.Persistence.Workspaces;

/// <summary>One permission-filtered workspace row with server-decided capabilities.</summary>
public sealed record WorkspaceSnapshot(
    WorkspaceId Id,
    string Name,
    int VersionRetentionDays,
    long StorageQuotaBytes,
    DateTimeOffset CreatedAt,
    PrincipalId? PersonalOwnerPrincipalId,
    bool CanRename,
    bool CanManageMembers,
    bool CanLeave,
    bool CanUseDailyNotes,
    Guid? PendingInvitationId);

/// <summary>One active human who can be offered workspace access.</summary>
public sealed record WorkspaceInviteeSnapshot(
    PrincipalId PrincipalId,
    string DisplayName,
    string Email);

/// <summary>One principal or group workspace grant with server-decided mutation capabilities.</summary>
public sealed record WorkspaceMemberSnapshot(
    string SubjectType,
    Guid SubjectId,
    string DisplayName,
    string? Email,
    string Role,
    DateTimeOffset GrantedAt,
    bool CanChangeRole,
    bool CanRemove,
    IReadOnlyList<string> AssignableRoles);

/// <summary>One durable invitation-history row.</summary>
public sealed record WorkspaceInvitationSnapshot(
    Guid InvitationId,
    string EmailNormalized,
    PrincipalId? TargetPrincipalId,
    string Role,
    string Status,
    PrincipalId InvitedByPrincipalId,
    DateTimeOffset InvitedAt,
    DateTimeOffset? AcceptedAt,
    PrincipalId? AcceptedByPrincipalId,
    DateTimeOffset? RevokedAt);

/// <summary>Outcome of one locked invitation state transition.</summary>
public sealed record WorkspaceInvitationMutationResult(
    string Outcome,
    WorkspaceInvitationSnapshot? Invitation);

/// <summary>Database operations for workspace administration.</summary>
public sealed class WorkspaceAdministrationStore
{
    private static readonly string[] PresetKeys = ["seed.kanban", "seed.calendar", "seed.list"];

    private readonly NixSqlExecutor _sql;
    private readonly INixSessionContextAccessor _session;

    /// <summary>Initializes the store.</summary>
    public WorkspaceAdministrationStore(NixSqlExecutor sql, INixSessionContextAccessor session)
    {
        ArgumentNullException.ThrowIfNull(sql);
        ArgumentNullException.ThrowIfNull(session);
        _sql = sql;
        _session = session;
    }

    private NixSessionContext Session => _session.Current
        ?? throw new InvalidOperationException("No session context was established for workspace administration.");

    /// <summary>Lists reachable workspaces without materializing unreachable tenant rows.</summary>
    public async ValueTask<IReadOnlyList<WorkspaceSnapshot>> ListAsync(
        DateTimeOffset? afterCreatedAt,
        WorkspaceId? afterId,
        int limit,
        CancellationToken cancellationToken)
    {
        var context = Session;
        var rows = new List<WorkspaceSnapshot>(limit);
        var query = _sql.QueryAsync<WorkspaceSnapshot, WorkspaceMapper>(
            WorkspaceAdministrationSql.List,
            default,
            [
                Uuid("tenant_id", context.TenantId.Value),
                Uuid("principal_id", context.PrincipalId.Value),
                TimestampOrNull("after_created_at", afterCreatedAt),
                UuidOrNull("after_id", afterId?.Value),
                Integer("limit", limit),
            ],
            cancellationToken);

        await foreach (var row in query.ConfigureAwait(false))
        {
            rows.Add(row);
        }

        return rows;
    }

    /// <summary>Gets one reachable workspace, returning null for absent and inaccessible alike.</summary>
    public async ValueTask<WorkspaceSnapshot?> FindAsync(
        WorkspaceId workspaceId,
        CancellationToken cancellationToken)
    {
        var context = Session;
        var query = _sql.QueryAsync<WorkspaceSnapshot, WorkspaceMapper>(
            WorkspaceAdministrationSql.Detail,
            default,
            [
                Uuid("tenant_id", context.TenantId.Value),
                Uuid("principal_id", context.PrincipalId.Value),
                Uuid("workspace_id", workspaceId.Value),
            ],
            cancellationToken);

        await foreach (var row in query.ConfigureAwait(false))
        {
            return row;
        }

        return null;
    }

    /// <summary>Creates a shared workspace and direct owner membership for an active human.</summary>
    public async ValueTask<bool> CreateAsync(
        WorkspaceId workspaceId,
        string name,
        DateTimeOffset now,
        CancellationToken cancellationToken)
    {
        var context = Session;
        return await _sql.ScalarOrDefaultAsync<bool>(
            WorkspaceAdministrationSql.Create,
            [
                Uuid("tenant_id", context.TenantId.Value),
                Uuid("principal_id", context.PrincipalId.Value),
                Uuid("workspace_id", workspaceId.Value),
                Text("name", name),
                Timestamp("now", now),
            ],
            cancellationToken).ConfigureAwait(false);
    }

    /// <summary>Creates the shipped template catalog and hidden roots for one new workspace.</summary>
    public async ValueTask SeedPresetsAsync(
        WorkspaceId workspaceId,
        DateTimeOffset now,
        CancellationToken cancellationToken)
    {
        var context = Session;
        var parameters = new List<NpgsqlParameter>
        {
            Uuid("tenant_id", context.TenantId.Value),
            Uuid("principal_id", context.PrincipalId.Value),
            Uuid("workspace_id", workspaceId.Value),
            Timestamp("now", now),
        };

        foreach (var key in PresetKeys)
        {
            var prefix = key[5..];
            parameters.Add(Uuid(
                $"{prefix}_template_id",
                DeterministicProvisioningId.PresetObject(workspaceId, key, "template")));
            parameters.Add(Uuid(
                $"{prefix}_root_id",
                DeterministicProvisioningId.PresetObject(workspaceId, key, "root")));
            parameters.Add(Uuid(
                $"{prefix}_source_id",
                DeterministicProvisioningId.PresetObject(workspaceId, key, "source-root")));
        }

        await _sql.ExecuteAsync(ProvisioningSql.SeedPresets, [.. parameters], cancellationToken)
            .ConfigureAwait(false);
    }

    /// <summary>Renames a reachable workspace when the caller can administer it.</summary>
    public async ValueTask<bool> RenameAsync(
        WorkspaceId workspaceId,
        string name,
        CancellationToken cancellationToken)
    {
        var context = Session;
        var result = await _sql.ScalarOrDefaultAsync<Guid>(
            WorkspaceAdministrationSql.Rename,
            [
                Uuid("tenant_id", context.TenantId.Value),
                Uuid("principal_id", context.PrincipalId.Value),
                Uuid("workspace_id", workspaceId.Value),
                Text("name", name),
            ],
            cancellationToken).ConfigureAwait(false);
        return result != Guid.Empty;
    }

    /// <summary>Lists principal and group grants visible to a workspace member or administrator.</summary>
    public async ValueTask<IReadOnlyList<WorkspaceMemberSnapshot>> ListMembersAsync(
        WorkspaceId workspaceId,
        DateTimeOffset? afterGrantedAt,
        string? afterSubjectType,
        Guid? afterId,
        int limit,
        CancellationToken cancellationToken)
    {
        var context = Session;
        var rows = new List<WorkspaceMemberSnapshot>(limit);
        var query = _sql.QueryAsync<WorkspaceMemberSnapshot, MemberMapper>(
            WorkspaceAdministrationSql.Members,
            default,
            [
                Uuid("tenant_id", context.TenantId.Value), Uuid("principal_id", context.PrincipalId.Value),
                Uuid("workspace_id", workspaceId.Value), TimestampOrNull("after_granted_at", afterGrantedAt),
                TextOrNull("after_subject_type", afterSubjectType), UuidOrNull("after_id", afterId),
                UuidOrNull("target_principal_id", null),
                Integer("limit", limit),
            ], cancellationToken);
        await foreach (var row in query.ConfigureAwait(false))
        {
            rows.Add(row);
        }
        return rows;
    }

    /// <summary>Lists active humans without effective workspace access for the invite dropdown.</summary>
    public async ValueTask<IReadOnlyList<WorkspaceInviteeSnapshot>> ListInviteesAsync(
        WorkspaceId workspaceId,
        PrincipalId? afterId,
        int limit,
        CancellationToken cancellationToken)
    {
        var context = Session;
        var rows = new List<WorkspaceInviteeSnapshot>(limit);
        var query = _sql.QueryAsync<WorkspaceInviteeSnapshot, InviteeMapper>(
            WorkspaceAdministrationSql.Invitees,
            default,
            [
                Uuid("tenant_id", context.TenantId.Value),
                Uuid("principal_id", context.PrincipalId.Value),
                Uuid("workspace_id", workspaceId.Value),
                UuidOrNull("after_id", afterId?.Value),
                Integer("limit", limit),
            ],
            cancellationToken);
        await foreach (var row in query.ConfigureAwait(false))
        {
            rows.Add(row);
        }
        return rows;
    }

    /// <summary>Reads one direct principal member without scanning a page.</summary>
    public async ValueTask<WorkspaceMemberSnapshot?> FindPrincipalMemberAsync(
        WorkspaceId workspaceId,
        PrincipalId principalId,
        CancellationToken cancellationToken)
    {
        var context = Session;
        var query = _sql.QueryAsync<WorkspaceMemberSnapshot, MemberMapper>(
            WorkspaceAdministrationSql.Members,
            default,
            [
                Uuid("tenant_id", context.TenantId.Value),
                Uuid("principal_id", context.PrincipalId.Value),
                Uuid("workspace_id", workspaceId.Value),
                TimestampOrNull("after_granted_at", null),
                TextOrNull("after_subject_type", null),
                UuidOrNull("after_id", null),
                Uuid("target_principal_id", principalId.Value),
                Integer("limit", 1),
            ],
            cancellationToken);
        await foreach (var row in query.ConfigureAwait(false))
        {
            return row;
        }

        return null;
    }

    /// <summary>Lists durable invitation history for an administering caller.</summary>
    public async ValueTask<IReadOnlyList<WorkspaceInvitationSnapshot>> ListInvitationsAsync(
        WorkspaceId workspaceId,
        DateTimeOffset? afterInvitedAt,
        Guid? afterId,
        int limit,
        CancellationToken cancellationToken)
    {
        var context = Session;
        var rows = new List<WorkspaceInvitationSnapshot>(limit);
        var query = _sql.QueryAsync<WorkspaceInvitationSnapshot, InvitationMapper>(
            WorkspaceAdministrationSql.Invitations,
            default,
            [
                Uuid("tenant_id", context.TenantId.Value), Uuid("principal_id", context.PrincipalId.Value),
                Uuid("workspace_id", workspaceId.Value), TimestampOrNull("after_invited_at", afterInvitedAt),
                UuidOrNull("after_id", afterId), Integer("limit", limit),
            ], cancellationToken);
        await foreach (var row in query.ConfigureAwait(false))
        {
            rows.Add(row);
        }
        return rows;
    }

    /// <summary>Reads one authorized invitation for stable absent-versus-state outcomes.</summary>
    public async ValueTask<WorkspaceInvitationSnapshot?> FindInvitationAsync(
        WorkspaceId workspaceId,
        Guid invitationId,
        CancellationToken cancellationToken)
    {
        var context = Session;
        var query = _sql.QueryAsync<WorkspaceInvitationSnapshot, InvitationMapper>(
            WorkspaceAdministrationSql.InvitationById,
            default,
            [
                Uuid("tenant_id", context.TenantId.Value), Uuid("principal_id", context.PrincipalId.Value),
                Uuid("workspace_id", workspaceId.Value), Uuid("invitation_id", invitationId),
            ], cancellationToken);
        await foreach (var row in query.ConfigureAwait(false))
        {
            return row;
        }

        return null;
    }

    /// <summary>Offers one provisioned human immediate provisional access.</summary>
    public async ValueTask<WorkspaceInvitationMutationResult> CreateInvitationAsync(
        WorkspaceId workspaceId,
        Guid invitationId,
        PrincipalId targetPrincipalId,
        string role,
        DateTimeOffset now,
        CancellationToken cancellationToken)
    {
        var context = Session;
        var query = _sql.QueryAsync<WorkspaceInvitationMutationResult, InvitationMutationMapper>(
            WorkspaceAdministrationSql.CreateInvitation, default,
            [
                Uuid("tenant_id", context.TenantId.Value), Uuid("principal_id", context.PrincipalId.Value),
                Uuid("workspace_id", workspaceId.Value), Uuid("invitation_id", invitationId),
                Uuid("target_principal_id", targetPrincipalId.Value), Text("role", role), Timestamp("now", now),
            ], cancellationToken);
        await foreach (var row in query.ConfigureAwait(false))
        {
            return row;
        }

        throw new InvalidOperationException("The invitation mutation did not report an outcome.");
    }

    /// <summary>Accepts the caller's pending invitation and makes its offered role durable.</summary>
    public async ValueTask<bool> AcceptInvitationAsync(
        WorkspaceId workspaceId,
        Guid invitationId,
        DateTimeOffset now,
        CancellationToken cancellationToken)
    {
        var context = Session;
        var id = await _sql.ScalarOrDefaultAsync<Guid>(
            WorkspaceAdministrationSql.AcceptInvitation,
            [Uuid("tenant_id", context.TenantId.Value), Uuid("principal_id", context.PrincipalId.Value),
             Uuid("workspace_id", workspaceId.Value), Uuid("invitation_id", invitationId), Timestamp("now", now)],
            cancellationToken).ConfigureAwait(false);
        return id != Guid.Empty;
    }

    /// <summary>Declines the caller's pending invitation and removes its provisional direct grant.</summary>
    public async ValueTask<bool> DeclineInvitationAsync(
        WorkspaceId workspaceId,
        Guid invitationId,
        DateTimeOffset now,
        CancellationToken cancellationToken)
    {
        var context = Session;
        var id = await _sql.ScalarOrDefaultAsync<Guid>(
            WorkspaceAdministrationSql.DeclineInvitation,
            [Uuid("tenant_id", context.TenantId.Value), Uuid("principal_id", context.PrincipalId.Value),
             Uuid("workspace_id", workspaceId.Value), Uuid("invitation_id", invitationId), Timestamp("now", now)],
            cancellationToken).ConfigureAwait(false);
        return id != Guid.Empty;
    }

    /// <summary>Revokes a pending invitation, retaining its row.</summary>
    public ValueTask<int> RevokeInvitationAsync(
        WorkspaceId workspaceId,
        Guid invitationId,
        DateTimeOffset now,
        CancellationToken cancellationToken)
    {
        var context = Session;
        return _sql.ExecuteAsync(WorkspaceAdministrationSql.RevokeInvitation,
            [Uuid("tenant_id", context.TenantId.Value), Uuid("principal_id", context.PrincipalId.Value),
             Uuid("workspace_id", workspaceId.Value), Uuid("invitation_id", invitationId), Timestamp("now", now)],
            cancellationToken);
    }

    /// <summary>Changes a direct member role if every ownership invariant remains true.</summary>
    public async ValueTask<bool> ChangeMemberRoleAsync(
        WorkspaceId workspaceId,
        PrincipalId target,
        string role,
        DateTimeOffset now,
        CancellationToken cancellationToken)
    {
        var context = Session;
        var id = await _sql.ScalarOrDefaultAsync<Guid>(WorkspaceAdministrationSql.ChangeMemberRole,
            [Uuid("tenant_id", context.TenantId.Value), Uuid("principal_id", context.PrincipalId.Value),
             Uuid("workspace_id", workspaceId.Value), Uuid("target_principal_id", target.Value),
             Text("role", role), Timestamp("now", now)], cancellationToken).ConfigureAwait(false);
        return id != Guid.Empty;
    }

    /// <summary>Removes a direct member or lets the caller leave, preserving recoverable ownership.</summary>
    public async ValueTask<bool> RemoveMemberAsync(
        WorkspaceId workspaceId,
        PrincipalId target,
        bool self,
        CancellationToken cancellationToken)
    {
        var context = Session;
        var id = await _sql.ScalarOrDefaultAsync<Guid>(WorkspaceAdministrationSql.RemoveMember,
            [Uuid("tenant_id", context.TenantId.Value), Uuid("principal_id", context.PrincipalId.Value),
             Uuid("workspace_id", workspaceId.Value), Uuid("target_principal_id", target.Value),
             Boolean("self", self)], cancellationToken).ConfigureAwait(false);
        return id != Guid.Empty;
    }

    /// <summary>Converts an owned personal workspace to shared and assigns a replacement owner.</summary>
    public async ValueTask<bool> RecoverAsync(
        WorkspaceId workspaceId,
        PrincipalId replacement,
        DateTimeOffset now,
        CancellationToken cancellationToken)
    {
        var context = Session;
        var id = await _sql.ScalarOrDefaultAsync<Guid>(WorkspaceAdministrationSql.Recover,
            [Uuid("tenant_id", context.TenantId.Value), Uuid("principal_id", context.PrincipalId.Value),
             Uuid("workspace_id", workspaceId.Value), Uuid("target_principal_id", replacement.Value),
             Timestamp("now", now)], cancellationToken).ConfigureAwait(false);
        return id != Guid.Empty;
    }

    /// <summary>Idempotently creates or returns one deterministic daily note.</summary>
    public async ValueTask<Guid?> OpenDailyNoteAsync(
        WorkspaceId workspaceId, Guid rootId, Guid itemId, string date,
        DateTimeOffset now, CancellationToken cancellationToken)
    {
        var context = Session;
        await _sql.ExecuteAsync(
            WorkspaceAdministrationSql.LockDailyNote,
            [Uuid("item_id", itemId)],
            cancellationToken).ConfigureAwait(false);
        var id = await _sql.ScalarOrDefaultAsync<Guid>(WorkspaceAdministrationSql.OpenDailyNote,
            [Uuid("tenant_id", context.TenantId.Value), Uuid("principal_id", context.PrincipalId.Value),
             Uuid("workspace_id", workspaceId.Value), Uuid("root_id", rootId), Uuid("item_id", itemId),
             Text("date", date), Timestamp("now", now)], cancellationToken).ConfigureAwait(false);
        return id == Guid.Empty ? null : id;
    }

    private static NpgsqlParameter Uuid(string name, Guid value) =>
        new(name, NpgsqlDbType.Uuid) { Value = value };
    private static NpgsqlParameter UuidOrNull(string name, Guid? value) =>
        new(name, NpgsqlDbType.Uuid) { Value = value is { } actual ? actual : DBNull.Value };
    private static NpgsqlParameter Text(string name, string value) =>
        new(name, NpgsqlDbType.Text) { Value = value };
    private static NpgsqlParameter TextOrNull(string name, string? value) =>
        new(name, NpgsqlDbType.Text) { Value = value is null ? DBNull.Value : value };
    private static NpgsqlParameter Integer(string name, int value) =>
        new(name, NpgsqlDbType.Integer) { Value = value };
    private static NpgsqlParameter Boolean(string name, bool value) =>
        new(name, NpgsqlDbType.Boolean) { Value = value };
    private static NpgsqlParameter Timestamp(string name, DateTimeOffset value) =>
        new(name, NpgsqlDbType.TimestampTz) { Value = value };
    private static NpgsqlParameter TimestampOrNull(string name, DateTimeOffset? value) =>
        new(name, NpgsqlDbType.TimestampTz) { Value = value is { } actual ? actual : DBNull.Value };

    private readonly struct WorkspaceMapper : INixRowMapper<WorkspaceSnapshot>
    {
        public WorkspaceSnapshot Map(NpgsqlDataReader reader) => new(
            WorkspaceId.From(reader.GetGuid(0)), reader.GetString(1), reader.GetInt32(2),
            reader.GetInt64(3), reader.GetFieldValue<DateTimeOffset>(4),
            reader.IsDBNull(5) ? null : PrincipalId.From(reader.GetGuid(5)),
            reader.GetBoolean(6), reader.GetBoolean(7), reader.GetBoolean(8),
            reader.GetBoolean(9), reader.IsDBNull(10) ? null : reader.GetGuid(10));
    }

    private readonly struct MemberMapper : INixRowMapper<WorkspaceMemberSnapshot>
    {
        public WorkspaceMemberSnapshot Map(NpgsqlDataReader reader) => new(
            reader.GetString(0), reader.GetGuid(1), reader.GetString(2),
            reader.IsDBNull(3) ? null : reader.GetString(3), reader.GetString(4),
            reader.GetFieldValue<DateTimeOffset>(5), reader.GetBoolean(6), reader.GetBoolean(7),
            reader.GetFieldValue<string[]>(8));
    }

    private readonly struct InviteeMapper : INixRowMapper<WorkspaceInviteeSnapshot>
    {
        public WorkspaceInviteeSnapshot Map(NpgsqlDataReader reader) => new(
            PrincipalId.From(reader.GetGuid(0)), reader.GetString(1), reader.GetString(2));
    }

    private readonly struct InvitationMapper : INixRowMapper<WorkspaceInvitationSnapshot>
    {
        public WorkspaceInvitationSnapshot Map(NpgsqlDataReader reader) => new(
            reader.GetGuid(0), reader.GetString(1),
            reader.IsDBNull(2) ? null : PrincipalId.From(reader.GetGuid(2)), reader.GetString(3), reader.GetString(4),
            PrincipalId.From(reader.GetGuid(5)), reader.GetFieldValue<DateTimeOffset>(6),
            reader.IsDBNull(7) ? null : reader.GetFieldValue<DateTimeOffset>(7),
            reader.IsDBNull(8) ? null : PrincipalId.From(reader.GetGuid(8)),
            reader.IsDBNull(9) ? null : reader.GetFieldValue<DateTimeOffset>(9));
    }

    private readonly struct InvitationMutationMapper : INixRowMapper<WorkspaceInvitationMutationResult>
    {
        public WorkspaceInvitationMutationResult Map(NpgsqlDataReader reader)
        {
            var outcome = reader.GetString(0);
            if (reader.IsDBNull(1))
            {
                return new WorkspaceInvitationMutationResult(outcome, null);
            }

            return new WorkspaceInvitationMutationResult(
                outcome,
                new WorkspaceInvitationSnapshot(
                    reader.GetGuid(1), reader.GetString(2),
                    reader.IsDBNull(3) ? null : PrincipalId.From(reader.GetGuid(3)), reader.GetString(4), reader.GetString(5),
                    PrincipalId.From(reader.GetGuid(6)), reader.GetFieldValue<DateTimeOffset>(7),
                    reader.IsDBNull(8) ? null : reader.GetFieldValue<DateTimeOffset>(8),
                    reader.IsDBNull(9) ? null : PrincipalId.From(reader.GetGuid(9)),
                    reader.IsDBNull(10) ? null : reader.GetFieldValue<DateTimeOffset>(10)));
        }
    }
}
