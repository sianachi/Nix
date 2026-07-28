using System.Globalization;
using Nix.Domain.Primitives;
using Nix.Features.Me;
using Nix.Integration.Tests.Harness;
using Nix.Messaging;

namespace Nix.Integration.Tests.Persistence;

/// <summary>
/// The caller's own profile, and in particular the administrator flag the shell hangs a menu on.
/// </summary>
/// <remarks>
/// The flag is the reason this endpoint exists: roles live in the database and never in tokens, so
/// the shell cannot decide whether to offer an administrative entry by decoding the token it
/// already holds. That makes "the flag is false for someone who was never granted the role" the
/// assertion worth having - the true case would pass just as well against a stub that always said
/// yes.
/// </remarks>
[Collection(PostgresCollectionDefinition.Name)]
public sealed class CurrentPrincipalTests : IAsyncLifetime
{
    /// <summary>A principal of the first tenant holding no tenant-wide role.</summary>
    private static readonly Guid OrdinaryMember = new("100000c0-1111-4111-8111-100000c00001");

    private readonly NixPostgresFixture _fixture;

    public CurrentPrincipalTests(NixPostgresFixture fixture) => _fixture = fixture;

    private static CancellationToken Cancellation => TestContext.Current.CancellationToken;

    public async ValueTask InitializeAsync()
    {
        await _fixture.ResetAsync();
        await M0SchemaSeed.SeedBothTenantsAsync(_fixture);
        await SeedOrdinaryMemberAsync();
    }

    public ValueTask DisposeAsync() => ValueTask.CompletedTask;

    [Fact]
    public async Task The_profile_reports_the_signed_in_principal()
    {
        var work = await _fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            var dispatcher = work.Resolve<NixDispatcher>();
            var result = await dispatcher.QueryAsync<GetCurrentPrincipal, Result<CurrentPrincipal>>(
                new GetCurrentPrincipal(),
                Cancellation);

            Assert.True(result.IsSuccess);
            Assert.Equal(M0SchemaSeed.Alpha.PrincipalId, result.Value.Id.Value);
            Assert.Equal(M0SchemaSeed.Alpha.TenantId, result.Value.TenantId.Value);
            Assert.Equal("alpha user", result.Value.DisplayName);
            Assert.Equal("alpha@example.test", result.Value.Email);
        }
    }

    [Fact]
    public async Task The_administrator_flag_is_true_for_a_principal_holding_the_tenant_role()
    {
        var work = await _fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            var dispatcher = work.Resolve<NixDispatcher>();
            var result = await dispatcher.QueryAsync<GetCurrentPrincipal, Result<CurrentPrincipal>>(
                new GetCurrentPrincipal(),
                Cancellation);

            Assert.True(result.Value.IsTenantAdministrator);
        }
    }

    [Fact]
    public async Task The_administrator_flag_is_false_for_a_principal_who_was_never_granted_it()
    {
        var context = TestTenants.ContextFor(
            M0SchemaSeed.Alpha.TenantId,
            M0SchemaSeed.Alpha.WorkspaceId,
            OrdinaryMember);

        var work = await _fixture.Application.BeginUnitOfWorkAsync(context, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            var dispatcher = work.Resolve<NixDispatcher>();
            var result = await dispatcher.QueryAsync<GetCurrentPrincipal, Result<CurrentPrincipal>>(
                new GetCurrentPrincipal(),
                Cancellation);

            Assert.True(result.IsSuccess);
            Assert.False(result.Value.IsTenantAdministrator);
            Assert.Equal("Ordinary member", result.Value.DisplayName);
        }
    }

    [Fact]
    public async Task The_profile_never_describes_a_principal_of_another_tenant()
    {
        // Beta's principal asked for inside Alpha's session. Row-level security makes the row
        // invisible rather than merely unreadable, so the use case has nothing to describe - which
        // is the correct answer and not a special case anybody had to write.
        var context = TestTenants.ContextFor(
            M0SchemaSeed.Alpha.TenantId,
            M0SchemaSeed.Alpha.WorkspaceId,
            M0SchemaSeed.Beta.PrincipalId);

        var work = await _fixture.Application.BeginUnitOfWorkAsync(context, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            var dispatcher = work.Resolve<NixDispatcher>();
            var result = await dispatcher.QueryAsync<GetCurrentPrincipal, Result<CurrentPrincipal>>(
                new GetCurrentPrincipal(),
                Cancellation);

            Assert.True(result.IsFailure);
            Assert.Equal("identity.principal_not_found", result.Error.Code);
        }
    }

    private async Task SeedOrdinaryMemberAsync()
    {
        var tenant = M0SchemaSeed.Alpha.TenantId.ToString("D", CultureInfo.InvariantCulture);
        var principal = OrdinaryMember.ToString("D", CultureInfo.InvariantCulture);

        var sql = $"""
            INSERT INTO principal
                (principal_id, tenant_id, external_subject, kind, display_name, email, status,
                 deprovisioned_at)
            VALUES ('{principal}'::uuid, '{tenant}'::uuid, 'alpha-ordinary', 'user',
                    'Ordinary member', 'ordinary@example.test', 'active', NULL);
            """;

        var connection = await _fixture.OpenMigratorConnectionAsync();
        await using (connection.ConfigureAwait(false))
        {
            await RawSql.ExecuteAsync(connection, transaction: null, sql);
        }
    }
}
