using System.Globalization;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Storage;
using Nix.Application.Persistence;
using Nix.Core.Audit;
using Nix.Core.Identity;
using Nix.Core.Tenancy;
using Nix.Infrastructure.Persistence;
using Nix.Integration.Tests.Harness;
using Npgsql;

namespace Nix.Integration.Tests.Persistence;

/// <summary>
/// Every table of the M0 schema isolates tenants, proved table by table against a real Postgres
/// holding two tenants' rows.
/// </summary>
/// <remarks>
/// <para>
/// The probe table proves the mechanism; this class proves the schema actually uses it. Those are
/// different claims, and the gap between them is exactly where a table added without a policy
/// would hide.
/// </para>
/// <para>
/// The theories run over <see cref="NixTables.TenantScoped"/> rather than over a list written
/// here, and a separate test asserts that list matches what the database contains. Together they
/// mean a new table cannot be added without either gaining a policy or failing a test - a list
/// maintained by hand next to the tables it describes would drift silently, which is the failure
/// this pair exists to prevent.
/// </para>
/// </remarks>
[Collection(PostgresCollectionDefinition.Name)]
public sealed class M0SchemaIsolationTests : IAsyncLifetime
{
    private readonly NixPostgresFixture _fixture;

    public M0SchemaIsolationTests(NixPostgresFixture fixture) => _fixture = fixture;

    /// <summary>Every tenant-scoped table, for assertions made as the schema owner.</summary>
    public static TheoryData<string> TenantScopedTables
    {
        get
        {
            var tables = new TheoryData<string>();
            foreach (var table in NixTables.TenantScoped)
            {
                tables.Add(table);
            }

            return tables;
        }
    }

    /// <summary>
    /// The tenant-scoped tables the runtime role may read, for assertions made as that role.
    /// </summary>
    /// <remarks>
    /// <c>audit_event</c> is absent because the runtime role holds only INSERT on it, so a
    /// select-based isolation check would fail on the privilege before it ever reached the policy
    /// and would prove nothing either way. Its isolation is asserted through the one privilege it
    /// does have, in
    /// <see cref="A_tenant_cannot_insert_an_audit_event_belonging_to_another_tenant"/>.
    /// </remarks>
    public static TheoryData<string> RuntimeReadableTenantScopedTables
    {
        get
        {
            var tables = new TheoryData<string>();
            foreach (var table in NixTables.TenantScoped)
            {
                if (!string.Equals(table, NixTables.AuditEvent, StringComparison.Ordinal))
                {
                    tables.Add(table);
                }
            }

            return tables;
        }
    }

    private static CancellationToken Cancellation => TestContext.Current.CancellationToken;

    public async ValueTask InitializeAsync()
    {
        await _fixture.ResetAsync();
        await M0SchemaSeed.SeedBothTenantsAsync(_fixture);
    }

    public ValueTask DisposeAsync() => ValueTask.CompletedTask;

    [Theory]
    [MemberData(nameof(RuntimeReadableTenantScopedTables))]
    public async Task Each_tenant_scoped_table_shows_a_tenant_only_its_own_row(string table)
    {
        // Both tenants hold exactly one row in every table, so "sees one" and "sees only its own"
        // are the same assertion made twice - deliberately, because a policy that returned
        // everything would satisfy neither and a policy that returned nothing would satisfy the
        // count but not the identity.
        var alphaRows = await ReadVisibleTenantIdsAsync(table, TestTenants.AlphaContext);
        var betaRows = await ReadVisibleTenantIdsAsync(table, TestTenants.BetaContext);

        Assert.Equal([TestTenants.Alpha], alphaRows);
        Assert.Equal([TestTenants.Beta], betaRows);
    }

    [Theory]
    [MemberData(nameof(RuntimeReadableTenantScopedTables))]
    public async Task Each_tenant_scoped_table_hides_every_row_from_a_session_with_no_tenant(string table)
    {
        // current_setting(..., true) yields NULL when unset, the comparison yields NULL, and no
        // row qualifies. An unscoped session must see nothing rather than everything.
        var connection = await _fixture.OpenApplicationConnectionAsync();
        await using (connection.ConfigureAwait(false))
        {
            var visible = await RawSql.CountAsync(connection, transaction: null, $"SELECT count(*) FROM {table}");
            Assert.Equal(0, visible);
        }
    }

    [Theory]
    [MemberData(nameof(TenantScopedTables))]
    public async Task Each_tenant_scoped_table_carries_a_policy_with_both_using_and_with_check(string table)
    {
        // Read from the catalogue rather than from the migration that was supposed to have
        // written it. USING alone would hide the other tenant's rows on read while still
        // permitting an insert that plants a row under their id.
        var connection = await _fixture.OpenMigratorConnectionAsync();
        await using (connection.ConfigureAwait(false))
        {
            var policies = await RawSql.TextListAsync(
                connection,
                $"""
                SELECT coalesce(qual, '(none)') || ' | ' || coalesce(with_check, '(none)')
                FROM pg_policies
                WHERE schemaname = 'public' AND tablename = '{table}'
                """);

            var policy = Assert.Single(policies);
            Assert.DoesNotContain("(none)", policy, StringComparison.Ordinal);

            // Both halves must consult the session setting; a policy that hard-coded a tenant or
            // compared the column to itself would still be two non-null expressions.
            var mentions = policy.Split("nix.tenant_id", StringSplitOptions.None).Length - 1;
            Assert.Equal(2, mentions);
        }
    }

    [Fact]
    public async Task The_tenant_scoped_table_list_names_every_table_the_database_actually_has()
    {
        var connection = await _fixture.OpenMigratorConnectionAsync();
        await using (connection.ConfigureAwait(false))
        {
            var actual = await RawSql.TextListAsync(
                connection,
                """
                SELECT c.relname
                FROM pg_class c
                JOIN pg_namespace n ON n.oid = c.relnamespace
                WHERE n.nspname = 'public'
                  AND c.relkind = 'r'
                  AND c.relname NOT LIKE '\_\_%'
                  AND c.relname <> 'rls_probe'
                ORDER BY c.relname
                """);

            Assert.Equal(NixTables.TenantScoped.Order(StringComparer.Ordinal), actual);
        }
    }

    [Fact]
    public async Task A_tenant_cannot_insert_an_audit_event_belonging_to_another_tenant()
    {
        // audit_event is insert-only for the runtime role, so INSERT is where its policy has to be
        // proved. Both directions are asserted: the write this tenant is entitled to must succeed,
        // or a policy that simply refused everything would pass the half that matters.
        var work = await _fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            var connection = (NpgsqlConnection)work.DbContext.Database.GetDbConnection();
            var transaction = (NpgsqlTransaction)work.Transaction.GetDbTransaction();

            var refused = await Assert.ThrowsAsync<PostgresException>(
                async () => await RawSql.ExecuteAsync(
                    connection,
                    transaction,
                    AuditEventInsertFor(TestTenants.Beta, M0SchemaSeed.Beta)));

            Assert.Equal(PostgresErrorCodes.InsufficientPrivilege, refused.SqlState);
        }

        var ownWork = await _fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        await using (ownWork.ConfigureAwait(false))
        {
            var connection = (NpgsqlConnection)ownWork.DbContext.Database.GetDbConnection();
            var transaction = (NpgsqlTransaction)ownWork.Transaction.GetDbTransaction();

            var written = await RawSql.ExecuteAsync(
                connection,
                transaction,
                AuditEventInsertFor(TestTenants.Alpha, M0SchemaSeed.Alpha));

            Assert.Equal(1, written);
        }
    }

    [Theory]
    [MemberData(nameof(RuntimeReadableTenantScopedTables))]
    public async Task A_tenant_cannot_write_a_row_belonging_to_another_tenant(string table)
    {
        // The WITH CHECK half, exercised the cheapest way that reaches every table: take the row
        // this tenant can see and try to relabel it as the other tenant's. The policy must refuse
        // rather than hand the row over.
        //
        var work = await _fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            var beta = TestTenants.Beta.ToString("D", CultureInfo.InvariantCulture);
            var connection = (NpgsqlConnection)work.DbContext.Database.GetDbConnection();
            var transaction = (NpgsqlTransaction)work.Transaction.GetDbTransaction();

            var failure = await Assert.ThrowsAsync<PostgresException>(
                async () => await RawSql.ExecuteAsync(
                    connection,
                    transaction,
                    $"UPDATE {table} SET tenant_id = '{beta}'::uuid"));

            // 42501 insufficient_privilege is what a WITH CHECK violation raises.
            Assert.Equal(PostgresErrorCodes.InsufficientPrivilege, failure.SqlState);
        }
    }

    [Theory]
    [MemberData(nameof(TenantScopedTables))]
    public async Task Each_table_grants_the_runtime_role_exactly_the_privileges_the_matrix_allows(string table)
    {
        // Asserted against the declared matrix rather than against "whatever full DML looks like",
        // because the database seed's ALTER DEFAULT PRIVILEGES makes grants fail open: a table a
        // migration forgets to narrow arrives readable and writable by the application. Comparing
        // against an expectation stated per table is what turns that default into a failure.
        var expected = NixTables.ExpectedApplicationPrivileges[table];

        var connection = await _fixture.OpenApplicationConnectionAsync();
        await using (connection.ConfigureAwait(false))
        {
            var granted = await RawSql.TextListAsync(
                connection,
                $"""
                SELECT privilege_type
                FROM information_schema.table_privileges
                WHERE table_schema = 'public'
                  AND table_name = '{table}'
                  AND grantee = 'nix_app'
                ORDER BY privilege_type
                """);

            Assert.Equal(expected, granted);
        }
    }

    [Fact]
    public void The_privilege_matrix_names_every_tenant_scoped_table()
    {
        // The theory above indexes into the matrix, so a table missing from it would throw rather
        // than fail readably. This says which one.
        var missing = NixTables.TenantScoped
            .Where(table => !NixTables.ExpectedApplicationPrivileges.ContainsKey(table))
            .ToArray();

        Assert.Empty(missing);
    }

    [Fact]
    public async Task Content_is_read_only_for_the_api_and_writable_by_the_collaboration_service()
    {
        // The split is the whole point of having a third role. An update can only be validated by
        // applying it, which needs a CRDT runtime the API does not have - so the API serves content
        // and never authors it, and a bug in the API cannot corrupt a document.
        //
        // Asserted in both directions: read-only that is actually read-write is a boundary that
        // does not exist, and read-write that is actually read-only is a service that cannot work.
        var connection = await _fixture.OpenMigratorConnectionAsync();
        await using (connection.ConfigureAwait(false))
        {
            foreach (var table in new[] { NixTables.ContentDoc, NixTables.ContentUpdate, NixTables.ContentSnapshot })
            {
                var application = await RawSql.TextListAsync(
                    connection,
                    $"""
                    SELECT privilege_type FROM information_schema.table_privileges
                    WHERE table_schema = 'public' AND table_name = '{table}'
                      AND grantee = '{NixDatabaseRoles.Application}'
                    ORDER BY privilege_type
                    """);

                var collaboration = await RawSql.TextListAsync(
                    connection,
                    $"""
                    SELECT privilege_type FROM information_schema.table_privileges
                    WHERE table_schema = 'public' AND table_name = '{table}'
                      AND grantee = '{NixDatabaseRoles.Collaboration}'
                    ORDER BY privilege_type
                    """);

                Assert.Equal(["SELECT"], application);
                Assert.Equal(["DELETE", "INSERT", "SELECT", "UPDATE"], collaboration);
            }
        }
    }

    [Fact]
    public async Task The_collaboration_role_cannot_bypass_row_level_security_either()
    {
        // A third role is a third chance to get this wrong. The isolation policies are only a
        // boundary while every role that reaches these tables is subject to them.
        var connection = await _fixture.OpenMigratorConnectionAsync();
        await using (connection.ConfigureAwait(false))
        {
            var canBypass = await RawSql.BooleanAsync(
                connection,
                $"SELECT rolbypassrls FROM pg_roles WHERE rolname = '{NixDatabaseRoles.Collaboration}'");

            Assert.False(canBypass);
        }
    }

    [Fact]
    public async Task An_audit_event_written_through_the_context_reaches_the_table()
    {
        // The runtime role holds INSERT on audit_event and nothing else, and insert-without-select
        // is exactly where EF bites: a store-generated property, or a provider that appends
        // RETURNING, turns the audit write into a privilege error. Raw SQL would not exercise
        // that, so this goes through NixDbContext the way the audit pipeline will.
        var work = await _fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            work.DbContext.AuditEvents.Add(new AuditEvent
            {
                Id = AuditEventId.Create(),
                TenantId = TenantId.From(TestTenants.Alpha),
                WorkspaceId = WorkspaceId.From(TestTenants.AlphaWorkspace),
                ActorId = PrincipalId.From(TestTenants.AlphaPrincipal),
                Action = "item.viewed",
                SubjectId = M0SchemaSeed.Alpha.ItemId,
                SubjectType = "item",
                OccurredAt = DateTimeOffset.UtcNow,
            });

            await work.DbContext.SaveChangesAsync(Cancellation);
            await work.CommitAsync(Cancellation);
        }

        // Read back as the migrator, because the role that wrote it deliberately cannot.
        var migrator = await _fixture.OpenMigratorConnectionAsync();
        await using (migrator.ConfigureAwait(false))
        {
            var written = await RawSql.CountAsync(
                migrator,
                transaction: null,
                $"SELECT count(*) FROM {NixTables.AuditEvent} WHERE action = 'item.viewed'");

            Assert.Equal(1, written);
        }
    }

    [Fact]
    public async Task Reading_audit_events_through_the_context_is_refused()
    {
        // The other half of insert-only, stated so that the day someone widens the grant to make a
        // query work, this fails and asks them to justify it.
        var work = await _fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            var failure = await Assert.ThrowsAsync<PostgresException>(
                async () => await work.DbContext.AuditEvents.CountAsync(Cancellation));

            Assert.Equal(PostgresErrorCodes.InsufficientPrivilege, failure.SqlState);
        }
    }

    private static string AuditEventInsertFor(Guid tenantId, M0TenantRows rows)
    {
        var tenant = tenantId.ToString("D", CultureInfo.InvariantCulture);
        var workspace = rows.WorkspaceId.ToString("D", CultureInfo.InvariantCulture);
        var principal = rows.PrincipalId.ToString("D", CultureInfo.InvariantCulture);
        var item = rows.ItemId.ToString("D", CultureInfo.InvariantCulture);

        return $"""
            INSERT INTO {NixTables.AuditEvent}
                (event_id, tenant_id, workspace_id, actor_id, on_behalf_of, action, subject_id,
                 subject_type, before, after, actor_ip, occurred_at)
            VALUES (gen_random_uuid(), '{tenant}'::uuid, '{workspace}'::uuid, '{principal}'::uuid,
                    NULL, 'item.viewed', '{item}'::uuid, 'item', NULL, NULL, NULL, now())
            """;
    }

    private async Task<IReadOnlyList<Guid>> ReadVisibleTenantIdsAsync(string table, NixSessionContext context)
    {
        var work = await _fixture.Application.BeginUnitOfWorkAsync(context, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            var connection = (NpgsqlConnection)work.DbContext.Database.GetDbConnection();
            var transaction = (NpgsqlTransaction)work.Transaction.GetDbTransaction();

            return await RawSql.GuidListAsync(
                connection,
                transaction,
                $"SELECT {NixTables.TenantIdColumn} FROM {table} ORDER BY 1");
        }
    }
}
