using Nix.Abstractions;
using Nix.Domain.Content;
using Nix.Domain.Identity;
using Nix.Domain.Tenancy;
using Nix.Features.Pets;
using Nix.Persistence;

namespace Nix.Tests.Features.Pets;

public sealed class PetSettingsTests
{
    private static readonly Guid PetId = new("33333333-3333-4333-8333-333333333333");
    private static PetProfile Owl => new(PetId, "Nix", "owl", "playful", "balanced", "Explain clearly.");
    private static PetSettings Settings => new(false, PetId, "system", false, [Owl]);
    private static CancellationToken Cancellation => TestContext.Current.CancellationToken;

    [Fact]
    public void One_owl_supports_each_independent_personality()
    {
        foreach (var personality in new[] { "calm", "playful", "encouraging", "concise" })
        {
            Assert.True(PetSettingsValidation.IsValid(Settings with { Profiles = [Owl with { Personality = personality }] }));
        }
    }

    [Fact]
    public void Invalid_profiles_and_dangling_active_references_are_refused()
    {
        Assert.False(PetSettingsValidation.IsValid(Settings with { Profiles = [Owl, Owl] }));
        Assert.False(PetSettingsValidation.IsValid(Settings with { Profiles = [Owl with { Name = " " }] }));
        Assert.False(PetSettingsValidation.IsValid(Settings with { Profiles = [Owl with { Appearance = "fox" }] }));
        Assert.False(PetSettingsValidation.IsValid(Settings with { Profiles = [Owl with { Instructions = new string('a', 2001) }] }));
        Assert.False(PetSettingsValidation.IsValid(Settings with { ActivePetId = Guid.NewGuid() }));
        Assert.False(PetSettingsValidation.IsValid(Settings with { Enabled = true, ActivePetId = null }));
        Assert.True(PetSettingsValidation.IsValid(PetSettingsValidation.Empty));
        Assert.False(PetSettingsValidation.IsValid(null));
    }

    [Fact]
    public async Task A_stale_save_does_not_overwrite_another_devices_edit()
    {
        var session = new ScopedNixSessionContextAccessor();
        session.Set(new NixSessionContext(TenantId.Create(), null, PrincipalId.Create()));
        var store = new MemoryStore();
        var handler = new SavePetSettingsHandler(store, session);
        var first = await handler.HandleAsync(new(0, Settings), Cancellation);
        var second = await handler.HandleAsync(new(0, Settings with { Narration = true }), Cancellation);
        Assert.True(first.IsSuccess);
        Assert.Equal(1, first.Value.Revision);
        Assert.True(second.IsFailure);
        Assert.Equal("pets.settings_conflict", second.Error.Code);
        var read = await new GetPetSettingsHandler(store, session).HandleAsync(new(), Cancellation);
        Assert.False(read.Settings.Narration);
    }

    private sealed class MemoryStore : IPetPreferencesStore
    {
        private PetPreferences? _saved;
        public ValueTask<PetPreferences?> FindAsync(TenantId tenantId, PrincipalId principalId, CancellationToken cancellationToken) =>
            ValueTask.FromResult(_saved is { } row && row.TenantId == tenantId && row.PrincipalId == principalId ? row : null);

        public Task<bool> SaveAsync(PetPreferences preferences, long expectedRevision, CancellationToken cancellationToken)
        {
            if ((_saved?.Revision ?? 0) != expectedRevision)
            {
                return Task.FromResult(false);
            }
            _saved = preferences;
            return Task.FromResult(true);
        }
    }
}
