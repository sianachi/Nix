using Microsoft.EntityFrameworkCore;
using Nix.Abstractions;
using Nix.Domain.Content;
using Nix.Domain.Primitives;
using Nix.Features.Pets;
using Nix.Integration.Tests.Harness;
using Nix.Messaging;
using Npgsql;

namespace Nix.Integration.Tests.Persistence;

[Collection(PostgresCollectionDefinition.Name)]
public sealed class PetPreferencesTests(NixPostgresFixture fixture) : IAsyncLifetime
{
    private static CancellationToken Cancellation => TestContext.Current.CancellationToken;

    public async ValueTask InitializeAsync()
    {
        await fixture.ResetAsync();
        await M0SchemaSeed.SeedBothTenantsAsync(fixture);
        var connection = await fixture.OpenMigratorConnectionAsync();
        await using (connection.ConfigureAwait(false))
        {
            // These tests exercise first-write behavior, unlike the fully populated schema fixture.
            await RawSql.ExecuteAsync(connection, transaction: null, "DELETE FROM pet_preferences");
        }
    }

    public ValueTask DisposeAsync() => ValueTask.CompletedTask;

    [Fact]
    public async Task Preferences_survive_a_new_request_and_refuse_stale_writes()
    {
        await SaveInitialAsync();
        var work = await fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            var dispatcher = work.Resolve<NixDispatcher>();
            var saved = await dispatcher.QueryAsync<GetPetSettings, PetSettingsResponse>(new(), Cancellation);
            Assert.Equal(1, saved.Revision);
            Assert.Equal("Owl", Assert.Single(saved.Settings.Profiles).Name);
            var conflict = await dispatcher.SendAsync<SavePetSettings, PetSettingsResponse>(new(0, saved.Settings), Cancellation);
            Assert.True(conflict.IsFailure);
            Assert.Equal("pets.settings_conflict", conflict.Error.Code);
            var updated = await dispatcher.SendAsync<SavePetSettings, PetSettingsResponse>(new(1, saved.Settings with { Narration = true }), Cancellation);
            Assert.True(updated.IsSuccess);
            Assert.Equal(2, updated.Value.Revision);
            await work.CommitAsync(Cancellation);
        }
    }

    [Fact]
    public async Task Rls_hides_other_tenants_and_other_principals_even_from_unfiltered_queries()
    {
        await SaveInitialAsync();
        foreach (var context in new[] { TestTenants.BetaContext,
            TestTenants.ContextFor(TestTenants.Alpha, TestTenants.AlphaWorkspace, TestTenants.BetaPrincipal) })
        {
            var work = await fixture.Application.BeginUnitOfWorkAsync(context, Cancellation);
            await using (work.ConfigureAwait(false))
            {
                Assert.Empty(await work.DbContext.Set<PetPreferences>().AsNoTracking().ToListAsync(Cancellation));
                var store = work.Resolve<IPetPreferencesStore>();
                Assert.Null(await store.FindAsync(TestTenants.AlphaContext.TenantId, TestTenants.AlphaContext.PrincipalId, Cancellation));
            }
        }
    }

    [Fact]
    public async Task Rls_refuses_a_forged_owner_on_insert()
    {
        var work = await fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            var error = await Assert.ThrowsAsync<PostgresException>(() => work.Resolve<IPetPreferencesStore>().SaveAsync(new PetPreferences
            {
                TenantId = TestTenants.BetaContext.TenantId,
                PrincipalId = TestTenants.BetaContext.PrincipalId,
                SettingsJson = "{}",
                Revision = 1,
            }, 0, Cancellation));
            Assert.Equal(PostgresErrorCodes.InsufficientPrivilege, error.SqlState);
        }
    }

    private async Task SaveInitialAsync()
    {
        var work = await fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            var id = Guid.NewGuid();
            var settings = new PetSettings(false, id, "system", false, [new(id, "Owl", "owl", "calm", "balanced", "")]);
            Result<PetSettingsResponse> saved = await work.Resolve<NixDispatcher>()
                .SendAsync<SavePetSettings, PetSettingsResponse>(new(0, settings), Cancellation);
            Assert.True(saved.IsSuccess);
            await work.CommitAsync(Cancellation);
        }
    }
}
