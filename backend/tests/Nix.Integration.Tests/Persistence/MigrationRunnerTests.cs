using Nix.Infrastructure.Persistence.Migrations;
using Nix.Integration.Tests.Harness;

namespace Nix.Integration.Tests.Persistence;

/// <summary>
/// Migrations run as the schema-owning role, from a separate process, and refuse to run as
/// anything else.
/// </summary>
[Collection(PostgresCollectionDefinition.Name)]
public sealed class MigrationRunnerTests
{
    private readonly NixPostgresFixture _fixture;

    public MigrationRunnerTests(NixPostgresFixture fixture) => _fixture = fixture;

    [Fact]
    public async Task Migrations_run_as_the_schema_owning_role()
    {
        // The same call the fixture makes during setup and the Kubernetes Job makes before a
        // rollout. Idempotent: re-running applies nothing.
        var outcome = await NixMigrationRunner.RunAsync(
            _fixture.MigratorConnectionString,
            NixDatabaseRoles.Application,
            TestContext.Current.CancellationToken);

        Assert.Equal(NixDatabaseRoles.Migrator, outcome.Role);
    }

    [Fact]
    public async Task Migrations_are_refused_when_the_connection_cannot_bypass_row_level_security()
    {
        // Handing the job the application's connection string is the plausible mistake: it is the
        // one already in the deployment's environment. It must fail the job, not migrate half the
        // schema under a role that cannot see other tenants' rows.
        var failure = await Assert.ThrowsAsync<InvalidOperationException>(
            async () => await NixMigrationRunner.RunAsync(
                _fixture.ApplicationConnectionString,
                NixDatabaseRoles.Application,
                TestContext.Current.CancellationToken));

        Assert.Contains(NixDatabaseRoles.Application, failure.Message, StringComparison.Ordinal);
        Assert.Contains("BYPASSRLS", failure.Message, StringComparison.Ordinal);
    }

    [Fact]
    public async Task The_migration_job_audits_the_runtime_role_while_it_is_connected()
    {
        // The audit passes here because nix_app is correctly confined. The value of asserting it
        // is that the audit runs at all: it is what would stop a rollout onto a cluster where
        // somebody had granted the runtime role BYPASSRLS.
        var outcome = await NixMigrationRunner.RunAsync(
            _fixture.MigratorConnectionString,
            NixDatabaseRoles.Application,
            TestContext.Current.CancellationToken);

        Assert.Equal(NixDatabaseRoles.Migrator, outcome.Role);
        Assert.Empty(outcome.AppliedNow);
    }
}
