using Nix.Integration.Tests.Harness;
using Npgsql;

namespace Nix.Integration.Tests.Persistence;

/// <summary>
/// The one hole in tenant isolation, and its exact shape: resolving a token's issuer to a tenant
/// before any tenant is known.
/// </summary>
/// <remarks>
/// <para>
/// Authentication has a bootstrap problem. It finds the tenant by matching a token's <c>iss</c>
/// and <c>aud</c> against <c>identity_provider</c> - so the tenant is the result of the lookup and
/// cannot also be its precondition. But that table carries the same tenant-keyed policy as
/// everything else, and the runtime role holds no <c>BYPASSRLS</c>, so a direct read correctly
/// returns nothing, forever.
/// </para>
/// <para>
/// <c>nix_resolve_identity_provider</c> is the answer, and these tests pin its shape rather than
/// merely its happy path. What matters is not only that it works but that it cannot be used for
/// anything else: no enumeration, no pattern matching, no disabled registrations, and no way for
/// a caller to widen it. A future change that made it more convenient would show up here as a
/// passing test that should not pass.
/// </para>
/// </remarks>
[Collection(PostgresCollectionDefinition.Name)]
public sealed class IdentityProviderResolverTests : IAsyncLifetime
{
    private const string Resolver = "nix_resolve_identity_provider";

    private readonly NixPostgresFixture _fixture;

    public IdentityProviderResolverTests(NixPostgresFixture fixture) => _fixture = fixture;

    public async ValueTask InitializeAsync()
    {
        await _fixture.ResetAsync();
        await M0SchemaSeed.SeedBothTenantsAsync(_fixture);
    }

    public ValueTask DisposeAsync() => ValueTask.CompletedTask;

    [Fact]
    public async Task The_runtime_role_still_cannot_read_the_table_directly()
    {
        // The premise of everything below. If this ever returns a row, the function is not the
        // only way in and its careful shape stops being the boundary.
        var connection = await _fixture.OpenApplicationConnectionAsync();
        await using (connection.ConfigureAwait(false))
        {
            var visible = await RawSql.CountAsync(
                connection,
                transaction: null,
                "SELECT count(*) FROM identity_provider");

            Assert.Equal(0, visible);
        }
    }

    [Fact]
    public async Task A_registered_issuer_resolves_to_its_tenant_from_a_session_with_no_tenant()
    {
        var connection = await _fixture.OpenApplicationConnectionAsync();
        await using (connection.ConfigureAwait(false))
        {
            var tenants = await RawSql.GuidListAsync(
                connection,
                transaction: null,
                $"""
                SELECT tenant_id FROM {Resolver}(
                    'https://issuer.{M0SchemaSeed.Alpha.Slug}.test', 'nix-api')
                """);

            var tenantId = Assert.Single(tenants);
            Assert.Equal(M0SchemaSeed.Alpha.TenantId, tenantId);
        }
    }

    [Fact]
    public async Task Each_tenants_issuer_resolves_only_to_that_tenant()
    {
        // Two tenants, two issuers. A function that returned the first enabled row regardless of
        // its arguments would pass the test above and fail this one.
        var connection = await _fixture.OpenApplicationConnectionAsync();
        await using (connection.ConfigureAwait(false))
        {
            var beta = await RawSql.GuidListAsync(
                connection,
                transaction: null,
                $"""
                SELECT tenant_id FROM {Resolver}(
                    'https://issuer.{M0SchemaSeed.Beta.Slug}.test', 'nix-api')
                """);

            Assert.Equal([M0SchemaSeed.Beta.TenantId], beta);
        }
    }

    [Fact]
    public async Task An_unregistered_issuer_resolves_to_nothing()
    {
        var connection = await _fixture.OpenApplicationConnectionAsync();
        await using (connection.ConfigureAwait(false))
        {
            var rows = await RawSql.CountAsync(
                connection,
                transaction: null,
                $"SELECT count(*) FROM {Resolver}('https://attacker.test', 'nix-api')");

            Assert.Equal(0, rows);
        }
    }

    [Fact]
    public async Task A_registered_issuer_with_the_wrong_audience_resolves_to_nothing()
    {
        // Both halves are matched, not just the issuer. An issuer trusted for one application is
        // not thereby trusted for another.
        var connection = await _fixture.OpenApplicationConnectionAsync();
        await using (connection.ConfigureAwait(false))
        {
            var rows = await RawSql.CountAsync(
                connection,
                transaction: null,
                $"""
                SELECT count(*) FROM {Resolver}(
                    'https://issuer.{M0SchemaSeed.Alpha.Slug}.test', 'some-other-audience')
                """);

            Assert.Equal(0, rows);
        }
    }

    [Fact]
    public async Task A_disabled_registration_resolves_to_nothing()
    {
        // Disabling is how trust is revoked in a hurry, and it has to take effect at the lookup
        // rather than only at some later check the caller might skip.
        var migrator = await _fixture.OpenMigratorConnectionAsync();
        await using (migrator.ConfigureAwait(false))
        {
            await RawSql.ExecuteAsync(
                migrator,
                transaction: null,
                $"""
                UPDATE identity_provider SET enabled = false
                WHERE issuer = 'https://issuer.{M0SchemaSeed.Alpha.Slug}.test'
                """);
        }

        var connection = await _fixture.OpenApplicationConnectionAsync();
        await using (connection.ConfigureAwait(false))
        {
            var rows = await RawSql.CountAsync(
                connection,
                transaction: null,
                $"""
                SELECT count(*) FROM {Resolver}(
                    'https://issuer.{M0SchemaSeed.Alpha.Slug}.test', 'nix-api')
                """);

            Assert.Equal(0, rows);
        }
    }

    [Fact]
    public async Task The_resolver_cannot_be_used_to_enumerate_registrations()
    {
        // The arguments are matched with equality, so there is no wildcard, no LIKE, and no empty
        // string that means "everything". This is what keeps a legitimate lookup from doubling as
        // a way to list every customer's identity provider.
        var connection = await _fixture.OpenApplicationConnectionAsync();
        await using (connection.ConfigureAwait(false))
        {
            var wildcarded = await RawSql.CountAsync(
                connection,
                transaction: null,
                $"SELECT count(*) FROM {Resolver}('%', '%')");

            var empty = await RawSql.CountAsync(
                connection,
                transaction: null,
                $"SELECT count(*) FROM {Resolver}('', '')");

            Assert.Equal(0, wildcarded);
            Assert.Equal(0, empty);
        }
    }

    [Fact]
    public async Task The_resolver_runs_as_its_owner_and_pins_its_search_path()
    {
        // Both are what make SECURITY DEFINER safe. Without the pinned search_path a caller could
        // shadow `identity_provider` with a table of their own and have the function read it with
        // the owner's privileges.
        var connection = await _fixture.OpenMigratorConnectionAsync();
        await using (connection.ConfigureAwait(false))
        {
            var definition = await RawSql.TextListAsync(
                connection,
                $"""
                SELECT p.prosecdef::text || ' | ' || coalesce(array_to_string(p.proconfig, ','), '')
                       || ' | ' || pg_get_userbyid(p.proowner)
                FROM pg_proc p
                JOIN pg_namespace n ON n.oid = p.pronamespace
                WHERE n.nspname = 'public' AND p.proname = '{Resolver}'
                """);

            var row = Assert.Single(definition);

            Assert.StartsWith("true |", row, StringComparison.Ordinal);
            Assert.Contains("search_path=public, pg_temp", row, StringComparison.Ordinal);
            Assert.EndsWith("| nix_migrator", row, StringComparison.Ordinal);
        }
    }

    [Fact]
    public async Task Only_the_runtime_role_may_execute_the_resolver()
    {
        var connection = await _fixture.OpenMigratorConnectionAsync();
        await using (connection.ConfigureAwait(false))
        {
            var publicMayExecute = await RawSql.BooleanAsync(
                connection,
                $"SELECT has_function_privilege('public', '{Resolver}(text,text)', 'EXECUTE')");

            var applicationMayExecute = await RawSql.BooleanAsync(
                connection,
                $"SELECT has_function_privilege('nix_app', '{Resolver}(text,text)', 'EXECUTE')");

            Assert.False(publicMayExecute);
            Assert.True(applicationMayExecute);
        }
    }
}
