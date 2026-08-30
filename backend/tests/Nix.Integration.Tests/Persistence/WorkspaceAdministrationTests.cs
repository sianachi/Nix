using Nix.Abstractions;
using Nix.Domain.Identity;
using Nix.Domain.Primitives;
using Nix.Domain.Provisioning;
using Nix.Domain.Tenancy;
using Nix.Features.Workspaces;
using Nix.Integration.Tests.Harness;
using Nix.Messaging;
using Nix.Persistence.Workspaces;

namespace Nix.Integration.Tests.Persistence;

[Collection(PostgresCollectionDefinition.Name)]
public sealed class WorkspaceAdministrationTests : IAsyncLifetime
{
    private static readonly Guid Alice = new("71717171-1111-4111-8111-717171717171");
    private static readonly Guid Bob = new("72727272-2222-4222-8222-727272727272");
    private static readonly Guid Service = new("73737373-3333-4333-8333-737373737373");
    private static readonly Guid Visible = new("74747474-4444-4444-8444-747474747474");
    private static readonly Guid Hidden = new("75757575-5555-4555-8555-757575757575");
    private static readonly Guid Charlie = new("76767676-6666-4666-8666-767676767676");
    private static readonly Guid Dana = new("77777777-7777-4777-8777-777777777777");
    private static readonly Guid Editors = new("78787878-8888-4888-8888-787878787878");

    private readonly NixPostgresFixture _fixture;

    public WorkspaceAdministrationTests(NixPostgresFixture fixture) => _fixture = fixture;

    private static CancellationToken Cancellation => TestContext.Current.CancellationToken;

    public async ValueTask InitializeAsync()
    {
        await _fixture.ResetAsync();
        await M0SchemaSeed.SeedBothTenantsAsync(_fixture);
        await SeedAsync();
    }

    public ValueTask DisposeAsync() => ValueTask.CompletedTask;

    [Fact]
    public async Task Listing_filters_in_sql_and_never_returns_an_unreachable_workspace()
    {
        var work = await _fixture.Application.BeginUnitOfWorkAsync(Context(Alice), Cancellation);
        await using (work.ConfigureAwait(false))
        {
            var rows = await work.Resolve<WorkspaceAdministrationStore>()
                .ListAsync(null, null, 20, Cancellation);

            var row = Assert.Single(rows);
            Assert.Equal(Visible, row.Id.Value);
            Assert.DoesNotContain(rows, workspace => workspace.Id.Value == Hidden);
            Assert.True(row.CanManageMembers);
        }
    }

    [Fact]
    public async Task Active_humans_create_shared_workspaces_but_service_principals_cannot()
    {
        var createdId = WorkspaceId.Create();
        var human = await _fixture.Application.BeginUnitOfWorkAsync(Context(Alice), Cancellation);
        await using (human.ConfigureAwait(false))
        {
            var store = human.Resolve<WorkspaceAdministrationStore>();
            Assert.True(await store.CreateAsync(createdId, "Alice project", DateTimeOffset.UtcNow, Cancellation));
            await store.SeedPresetsAsync(createdId, DateTimeOffset.UtcNow, Cancellation);
            Assert.Equal("Alice project", (await store.FindAsync(createdId, Cancellation))?.Name);
            await human.CommitAsync(Cancellation);
        }

        var connection = await _fixture.OpenMigratorConnectionAsync();
        await using (connection.ConfigureAwait(false))
        {
            Assert.Equal(3, await RawSql.CountAsync(
                connection,
                transaction: null,
                $"SELECT count(*) FROM workspace_template WHERE workspace_id = '{createdId.Value:D}'"));
        }

        var service = await _fixture.Application.BeginUnitOfWorkAsync(Context(Service), Cancellation);
        await using (service.ConfigureAwait(false))
        {
            Assert.False(await service.Resolve<WorkspaceAdministrationStore>().CreateAsync(
                WorkspaceId.Create(), "Machine project", DateTimeOffset.UtcNow, Cancellation));
        }
    }

    [Fact]
    public async Task Last_active_human_owner_is_not_demoted_until_another_owner_exists()
    {
        var work = await _fixture.Application.BeginUnitOfWorkAsync(Context(Alice), Cancellation);
        await using (work.ConfigureAwait(false))
        {
            var store = work.Resolve<WorkspaceAdministrationStore>();
            Assert.False(await store.ChangeMemberRoleAsync(
                WorkspaceId.From(Visible), PrincipalId.From(Alice), "editor", DateTimeOffset.UtcNow, Cancellation));

            var accepted = await store.CreateInvitationAsync(
                WorkspaceId.From(Visible), Guid.CreateVersion7(), "bob@example.test", "owner",
                DateTimeOffset.UtcNow, Cancellation);
            Assert.Equal("accepted", accepted.Invitation?.Status);

            Assert.True(await store.ChangeMemberRoleAsync(
                WorkspaceId.From(Visible), PrincipalId.From(Alice), "editor", DateTimeOffset.UtcNow, Cancellation));
        }
    }

    [Fact]
    public async Task Personal_owner_is_protected_and_collaborators_cannot_be_assigned_owner()
    {
        await SetPersonalOwnerAsync();
        var work = await _fixture.Application.BeginUnitOfWorkAsync(Context(Alice), Cancellation);
        await using (work.ConfigureAwait(false))
        {
            var store = work.Resolve<WorkspaceAdministrationStore>();
            Assert.False(await store.RemoveMemberAsync(
                WorkspaceId.From(Visible), PrincipalId.From(Alice), false, Cancellation));
            var refused = await store.CreateInvitationAsync(
                WorkspaceId.From(Visible), Guid.CreateVersion7(), "bob@example.test", "owner",
                DateTimeOffset.UtcNow, Cancellation);
            Assert.Equal("conflict", refused.Outcome);
            Assert.Null(refused.Invitation);
        }
    }

    [Fact]
    public async Task Pending_invitation_role_conflicts_preserve_history_and_exact_verified_matches_accept_it()
    {
        var invitationId = Guid.CreateVersion7();
        var work = await _fixture.Application.BeginUnitOfWorkAsync(Context(Alice), Cancellation);
        await using (work.ConfigureAwait(false))
        {
            var store = work.Resolve<WorkspaceAdministrationStore>();
            var pending = await store.CreateInvitationAsync(
                WorkspaceId.From(Visible), invitationId, "charlie@example.test", "editor",
                DateTimeOffset.UtcNow, Cancellation);
            Assert.Equal("pending", pending.Invitation?.Status);

            var conflict = await store.CreateInvitationAsync(
                WorkspaceId.From(Visible), Guid.CreateVersion7(), "charlie@example.test", "viewer",
                DateTimeOffset.UtcNow, Cancellation);
            Assert.Equal("conflict", conflict.Outcome);
            var history = Assert.Single(await store.ListInvitationsAsync(
                WorkspaceId.From(Visible), null, null, 20, Cancellation));
            Assert.Equal(invitationId, history.InvitationId);
            Assert.Equal("editor", history.Role);
            await work.CommitAsync(Cancellation);
        }

        await InsertHumanAsync(Charlie, "charlie", "charlie@example.test", verified: true);
        var accepting = await _fixture.Application.BeginUnitOfWorkAsync(Context(Alice), Cancellation);
        await using (accepting.ConfigureAwait(false))
        {
            var accepted = await accepting.Resolve<WorkspaceAdministrationStore>().CreateInvitationAsync(
                WorkspaceId.From(Visible), Guid.CreateVersion7(), "charlie@example.test", "editor",
                DateTimeOffset.UtcNow, Cancellation);
            Assert.Equal(invitationId, accepted.Invitation?.InvitationId);
            Assert.Equal("accepted", accepted.Invitation?.Status);
            Assert.Equal(Charlie, accepted.Invitation?.AcceptedByPrincipalId?.Value);
            Assert.NotNull(accepted.Invitation?.AcceptedAt);
            Assert.Equal("editor", (await accepting.Resolve<WorkspaceAdministrationStore>()
                .FindPrincipalMemberAsync(WorkspaceId.From(Visible), PrincipalId.From(Charlie), Cancellation))?.Role);
        }
    }

    [Fact]
    public async Task Unverified_or_ambiguous_email_matches_remain_pending()
    {
        await InsertHumanAsync(Charlie, "charlie", "shared@example.test", verified: false);
        await InsertHumanAsync(Dana, "dana", "ambiguous@example.test", verified: true);
        await InsertHumanAsync(Guid.CreateVersion7(), "erin", "ambiguous@example.test", verified: true);

        var work = await _fixture.Application.BeginUnitOfWorkAsync(Context(Alice), Cancellation);
        await using (work.ConfigureAwait(false))
        {
            var store = work.Resolve<WorkspaceAdministrationStore>();
            var unverified = await store.CreateInvitationAsync(
                WorkspaceId.From(Visible), Guid.CreateVersion7(), "shared@example.test", "viewer",
                DateTimeOffset.UtcNow, Cancellation);
            var ambiguous = await store.CreateInvitationAsync(
                WorkspaceId.From(Visible), Guid.CreateVersion7(), "ambiguous@example.test", "viewer",
                DateTimeOffset.UtcNow, Cancellation);
            Assert.Equal("pending", unverified.Invitation?.Status);
            Assert.Equal("pending", ambiguous.Invitation?.Status);
        }
    }

    [Fact]
    public async Task A_last_owner_cannot_self_invite_to_a_lower_role()
    {
        var work = await _fixture.Application.BeginUnitOfWorkAsync(Context(Alice), Cancellation);
        await using (work.ConfigureAwait(false))
        {
            var result = await work.Resolve<WorkspaceAdministrationStore>().CreateInvitationAsync(
                WorkspaceId.From(Visible), Guid.CreateVersion7(), "alice@example.test", "editor",
                DateTimeOffset.UtcNow, Cancellation);
            Assert.Equal("conflict", result.Outcome);
            Assert.Equal("owner", (await work.Resolve<WorkspaceAdministrationStore>()
                .FindPrincipalMemberAsync(WorkspaceId.From(Visible), PrincipalId.From(Alice), Cancellation))?.Role);
        }
    }

    [Fact]
    public async Task Group_editor_can_open_daily_notes_but_viewer_and_commenter_cannot()
    {
        await SeedDailyRootAsync();
        await AddGroupMembershipAsync(Bob, "editor");
        var editor = await OpenDailyThroughCoreAsync(Bob, "2026-08-29");
        Assert.True(editor.IsSuccess);

        await SetGroupRoleAsync("viewer");
        Assert.False((await OpenDailyThroughCoreAsync(Bob, "2026-08-28")).IsSuccess);
        await SetGroupRoleAsync("commenter");
        Assert.False((await OpenDailyThroughCoreAsync(Bob, "2026-08-27")).IsSuccess);
    }

    [Fact]
    public async Task Recovery_requires_an_offboarded_personal_owner_and_converts_to_shared_once()
    {
        await SetPersonalOwnerAsync();
        await GrantTenantAdminAsync(Alice);
        var activeOwner = await RecoverAsync();
        Assert.False(activeOwner);

        await SetPrincipalStatusAsync(Alice, "suspended");
        Assert.True(await RecoverAsync());
        Assert.False(await RecoverAsync());

        var work = await _fixture.Application.BeginUnitOfWorkAsync(Context(Alice), Cancellation);
        await using (work.ConfigureAwait(false))
        {
            var recovered = await work.Resolve<WorkspaceAdministrationStore>().FindAsync(
                WorkspaceId.From(Visible), Cancellation);
            Assert.Null(recovered?.PersonalOwnerPrincipalId);
            Assert.Equal("owner", (await work.Resolve<WorkspaceAdministrationStore>()
                .FindPrincipalMemberAsync(WorkspaceId.From(Visible), PrincipalId.From(Bob), Cancellation))?.Role);
        }
    }

    [Fact]
    public async Task Two_simultaneous_daily_opens_return_the_one_deterministic_item()
    {
        await SeedDailyRootAsync();
        const string date = "2026-08-30";
        var expected = DeterministicProvisioningId.DatedDailyNote(WorkspaceId.From(Visible), date);

        async Task<Guid?> OpenAsync()
        {
            var work = await _fixture.Application.BeginUnitOfWorkAsync(Context(Alice), Cancellation);
            await using (work.ConfigureAwait(false))
            {
                var id = await work.Resolve<WorkspaceAdministrationStore>().OpenDailyNoteAsync(
                    WorkspaceId.From(Visible),
                    DeterministicProvisioningId.DailyNotesRoot(WorkspaceId.From(Visible)),
                    expected,
                    date,
                    DateTimeOffset.UtcNow,
                    Cancellation);
                await work.CommitAsync(Cancellation);
                return id;
            }
        }

        var opened = await Task.WhenAll(OpenAsync(), OpenAsync());
        Assert.All(opened, itemId => Assert.Equal(expected, itemId));

        var connection = await _fixture.OpenMigratorConnectionAsync();
        await using (connection.ConfigureAwait(false))
        {
            var count = await RawSql.CountAsync(
                connection,
                transaction: null,
                $"SELECT count(*) FROM item WHERE id = '{expected:D}'::uuid");
            Assert.Equal(1, count);
        }
    }

    private async Task SeedAsync()
    {
        var connection = await _fixture.OpenMigratorConnectionAsync();
        await using (connection.ConfigureAwait(false))
        {
            await RawSql.ExecuteAsync(connection, null, $"""
                INSERT INTO principal
                    (principal_id, tenant_id, external_issuer, external_subject, kind, display_name,
                     email, email_normalized, email_verified, status)
                VALUES
                    ('{Alice:D}', '{M0SchemaSeed.Alpha.TenantId:D}', 'https://issuer.alpha.test',
                     'alice', 'user', 'Alice', 'alice@example.test', 'alice@example.test', true, 'active'),
                    ('{Bob:D}', '{M0SchemaSeed.Alpha.TenantId:D}', 'https://issuer.alpha.test',
                     'bob', 'user', 'Bob', 'bob@example.test', 'bob@example.test', true, 'active'),
                    ('{Service:D}', '{M0SchemaSeed.Alpha.TenantId:D}', 'https://issuer.alpha.test',
                     'service', 'service', 'Service', NULL, NULL, false, 'active');

                INSERT INTO workspace
                    (workspace_id, tenant_id, name, version_retention_days,
                     coalesce_window_min, storage_quota_bytes, created_at)
                VALUES
                    ('{Visible:D}', '{M0SchemaSeed.Alpha.TenantId:D}', 'Visible', 90, 10, 10737418240, now()),
                    ('{Hidden:D}', '{M0SchemaSeed.Alpha.TenantId:D}', 'Hidden', 90, 10, 10737418240, now());

                INSERT INTO workspace_member
                    (workspace_id, subject_type, subject_id, tenant_id, role, granted_by, granted_at)
                VALUES ('{Visible:D}', 'principal', '{Alice:D}', '{M0SchemaSeed.Alpha.TenantId:D}',
                        'owner', '{Alice:D}', now());
                """);
        }
    }

    private async Task SetPersonalOwnerAsync()
    {
        var connection = await _fixture.OpenMigratorConnectionAsync();
        await using (connection.ConfigureAwait(false))
        {
            await RawSql.ExecuteAsync(connection, null, $"""
                UPDATE workspace SET personal_owner_principal_id = '{Alice:D}'
                 WHERE workspace_id = '{Visible:D}';
                """);
        }
    }

    private async Task SeedDailyRootAsync()
    {
        var root = DeterministicProvisioningId.DailyNotesRoot(WorkspaceId.From(Visible));
        var connection = await _fixture.OpenMigratorConnectionAsync();
        await using (connection.ConfigureAwait(false))
        {
            await RawSql.ExecuteAsync(connection, null, $"""
                INSERT INTO item
                    (id, tenant_id, workspace_id, type, parent_id, seq, properties, lifecycle_state,
                     created_by, last_modified_by, created_at, last_modified_at)
                VALUES ('{root:D}', '{M0SchemaSeed.Alpha.TenantId:D}', '{Visible:D}', 'note', NULL,
                        1000, jsonb_build_object('title', 'Daily notes'), 'active',
                        '{Alice:D}', '{Alice:D}', now(), now());
                INSERT INTO item_closure (descendant_id, ancestor_id, tenant_id, workspace_id, depth)
                VALUES ('{root:D}', '{root:D}', '{M0SchemaSeed.Alpha.TenantId:D}', '{Visible:D}', 0);
                """);
        }
    }

    private async Task InsertHumanAsync(Guid id, string subject, string email, bool verified)
    {
        var connection = await _fixture.OpenMigratorConnectionAsync();
        await using (connection.ConfigureAwait(false))
        {
            await RawSql.ExecuteAsync(connection, null, $"""
                INSERT INTO principal
                    (principal_id, tenant_id, external_issuer, external_subject, kind, display_name,
                     email, email_normalized, email_verified, status)
                VALUES ('{id:D}', '{M0SchemaSeed.Alpha.TenantId:D}', 'https://issuer.alpha.test',
                        '{subject}', 'user', '{subject}', '{email}',
                        {(verified ? $"'{email}'" : "NULL")}, {(verified ? "true" : "false")}, 'active');
                """);
        }
    }

    private async Task AddGroupMembershipAsync(Guid principalId, string role)
    {
        var connection = await _fixture.OpenMigratorConnectionAsync();
        await using (connection.ConfigureAwait(false))
        {
            await RawSql.ExecuteAsync(connection, null, $"""
                INSERT INTO principal_group (group_id, tenant_id, name, external_id)
                VALUES ('{Editors:D}', '{M0SchemaSeed.Alpha.TenantId:D}', 'Editors', 'workspace-admin-editors');
                INSERT INTO group_membership (group_id, principal_id, tenant_id, source)
                VALUES ('{Editors:D}', '{principalId:D}', '{M0SchemaSeed.Alpha.TenantId:D}', 'directory');
                INSERT INTO workspace_member
                    (workspace_id, subject_type, subject_id, tenant_id, role, granted_by, granted_at)
                VALUES ('{Visible:D}', 'group', '{Editors:D}', '{M0SchemaSeed.Alpha.TenantId:D}',
                        '{role}', '{Alice:D}', now());
                """);
        }
    }

    private async Task SetGroupRoleAsync(string role)
    {
        var connection = await _fixture.OpenMigratorConnectionAsync();
        await using (connection.ConfigureAwait(false))
        {
            await RawSql.ExecuteAsync(connection, null, $"""
                UPDATE workspace_member SET role = '{role}'
                WHERE workspace_id = '{Visible:D}' AND subject_type = 'group' AND subject_id = '{Editors:D}';
                """);
        }
    }

    private async Task<Result<Guid>> OpenDailyThroughCoreAsync(Guid principalId, string date)
    {
        var work = await _fixture.Application.BeginUnitOfWorkAsync(Context(principalId), Cancellation);
        await using (work.ConfigureAwait(false))
        {
            return await work.Resolve<NixDispatcher>().SendAsync<OpenDailyNote, Guid>(
                new OpenDailyNote(WorkspaceId.From(Visible), date), Cancellation);
        }
    }

    private async Task GrantTenantAdminAsync(Guid principalId)
    {
        var connection = await _fixture.OpenMigratorConnectionAsync();
        await using (connection.ConfigureAwait(false))
        {
            await RawSql.ExecuteAsync(connection, null, $"""
                INSERT INTO tenant_role (tenant_id, subject_type, subject_id, role, granted_by, granted_at)
                VALUES ('{M0SchemaSeed.Alpha.TenantId:D}', 'principal', '{principalId:D}', 'admin',
                        '{principalId:D}', now());
                """);
        }
    }

    private async Task SetPrincipalStatusAsync(Guid principalId, string status)
    {
        var connection = await _fixture.OpenMigratorConnectionAsync();
        await using (connection.ConfigureAwait(false))
        {
            await RawSql.ExecuteAsync(connection, null, $"""
                UPDATE principal SET status = '{status}' WHERE principal_id = '{principalId:D}';
                """);
        }
    }

    private async Task<bool> RecoverAsync()
    {
        var work = await _fixture.Application.BeginUnitOfWorkAsync(Context(Alice), Cancellation);
        await using (work.ConfigureAwait(false))
        {
            var recovered = await work.Resolve<WorkspaceAdministrationStore>().RecoverAsync(
                WorkspaceId.From(Visible), PrincipalId.From(Bob), DateTimeOffset.UtcNow, Cancellation);
            if (recovered)
            {
                await work.CommitAsync(Cancellation);
            }
            return recovered;
        }
    }

    private static NixSessionContext Context(Guid principalId) => NixSessionContext.ForTenant(
        TenantId.From(M0SchemaSeed.Alpha.TenantId), PrincipalId.From(principalId));
}
