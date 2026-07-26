using Nix.Integration.Tests.Harness;
using Npgsql;

namespace Nix.Integration.Tests.Persistence;

/// <summary>
/// The database's own account of what each role may do, read from the catalogue and from
/// attempted operations - never from documentation.
/// </summary>
/// <remarks>
/// Every isolation test in this suite is worthless if the runtime role can bypass policies or
/// change the schema. These assertions are the foundation the others stand on, so they interrogate
/// the live cluster rather than the SQL that was supposed to have configured it.
/// </remarks>
[Collection(PostgresCollectionDefinition.Name)]
public sealed class DatabaseRoleTests
{
    private readonly NixPostgresFixture _fixture;

    public DatabaseRoleTests(NixPostgresFixture fixture) => _fixture = fixture;

    [Fact]
    public async Task The_application_role_cannot_bypass_row_level_security()
    {
        var connection = await _fixture.OpenApplicationConnectionAsync();
        await using (connection.ConfigureAwait(false))
        {
            var canBypass = await RawSql.BooleanAsync(
                connection,
                $"SELECT rolbypassrls FROM pg_roles WHERE rolname = '{NixDatabaseRoles.Application}'");

            Assert.False(canBypass);
        }
    }

    [Fact]
    public async Task The_migration_role_is_the_only_non_superuser_that_can_bypass_row_level_security()
    {
        var connection = await _fixture.OpenMigratorConnectionAsync();
        await using (connection.ConfigureAwait(false))
        {
            // Superusers are excluded because the attribute is implied for them; the cluster
            // superuser exists only to provision the roles and is never used by the application.
            var roles = await RawSql.TextListAsync(
                connection,
                "SELECT rolname FROM pg_roles WHERE rolbypassrls AND NOT rolsuper ORDER BY rolname");

            Assert.Equal([NixDatabaseRoles.Migrator], roles);
        }
    }

    [Fact]
    public async Task The_application_role_cannot_create_objects_in_the_schema()
    {
        var connection = await _fixture.OpenApplicationConnectionAsync();
        await using (connection.ConfigureAwait(false))
        {
            var failure = await Assert.ThrowsAsync<PostgresException>(
                async () => await RawSql.ExecuteAsync(
                    connection,
                    transaction: null,
                    "CREATE TABLE application_role_should_not_be_able_to_create_this (id integer)"));

            Assert.Equal(PostgresErrorCodes.InsufficientPrivilege, failure.SqlState);
        }
    }

    [Fact]
    public async Task The_application_role_cannot_disable_row_level_security_on_a_table()
    {
        var connection = await _fixture.OpenApplicationConnectionAsync();
        await using (connection.ConfigureAwait(false))
        {
            // Turning the policy off is a shorter route to every tenant's data than defeating it.
            // Only the table owner may, and the runtime role owns nothing.
            var failure = await Assert.ThrowsAsync<PostgresException>(
                async () => await RawSql.ExecuteAsync(
                    connection,
                    transaction: null,
                    $"ALTER TABLE {RlsProbeSchema.TableName} DISABLE ROW LEVEL SECURITY"));

            Assert.Equal(PostgresErrorCodes.InsufficientPrivilege, failure.SqlState);
        }
    }

    [Fact]
    public async Task The_application_role_cannot_add_a_permissive_policy_of_its_own()
    {
        var connection = await _fixture.OpenApplicationConnectionAsync();
        await using (connection.ConfigureAwait(false))
        {
            var failure = await Assert.ThrowsAsync<PostgresException>(
                async () => await RawSql.ExecuteAsync(
                    connection,
                    transaction: null,
                    $"CREATE POLICY see_everything ON {RlsProbeSchema.TableName} USING (true)"));

            Assert.Equal(PostgresErrorCodes.InsufficientPrivilege, failure.SqlState);
        }
    }

    [Fact]
    public async Task Row_level_security_is_enabled_and_forced_on_every_tenant_scoped_table()
    {
        var connection = await _fixture.OpenMigratorConnectionAsync();
        await using (connection.ConfigureAwait(false))
        {
            // Enabled without forced would exempt the table owner. The owner is nix_migrator,
            // which bypasses anyway, but the tenancy goal will add tables owned by roles that do
            // not - so the shape is asserted from the start.
            var unprotected = await RawSql.TextListAsync(
                connection,
                """
                SELECT c.relname
                FROM pg_class c
                JOIN pg_namespace n ON n.oid = c.relnamespace
                WHERE n.nspname = 'public'
                  AND c.relkind = 'r'
                  AND c.relname NOT LIKE '\_\_%'
                  AND (NOT c.relrowsecurity OR NOT c.relforcerowsecurity)
                ORDER BY c.relname
                """);

            Assert.Empty(unprotected);
        }
    }
}
