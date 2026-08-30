using Nix.Abstractions;
using Nix.Domain.Identity;
using Nix.Domain.Tenancy;
using Nix.Features.Identity;

namespace Nix.Tests.Features.Identity;

public sealed class CompleteBrowserSignInHandlerTests
{
    [Fact]
    public async Task A_missing_principal_is_provisioned_and_the_same_session_is_stored()
    {
        var tenantId = TenantId.From(Guid.NewGuid());
        var principalId = PrincipalId.Create();
        var principal = new AuthenticatedPrincipal(
            principalId,
            tenantId,
            PrincipalStatus.Active,
            "Browser Person");
        var provisioner = new FakeProvisioner(principal);
        var sessions = new FakeBrowserSessions();
        var handler = new CompleteBrowserSignInHandler(provisioner, sessions);
        var profile = new UserInfoProfile("Browser Person", "person@example.test", EmailVerified: true);
        var session = Session(tenantId, principalId);
        using var cancellation = new CancellationTokenSource();
        var command = new CompleteBrowserSignIn(
            tenantId,
            "https://issuer.example.test",
            "subject-1",
            profile,
            ExistingPrincipal: null,
            session);

        var result = await handler.HandleAsync(command, cancellation.Token);

        Assert.True(result.IsSuccess);
        Assert.Equal(principal, result.Value.Principal);
        Assert.Same(session, sessions.Added);
        Assert.Equal(cancellation.Token, sessions.CancellationToken);
        Assert.Equal(command.Subject, provisioner.Subject);
        Assert.Equal(profile, provisioner.Profile);
    }

    [Fact]
    public async Task A_session_for_another_principal_is_refused_before_storage()
    {
        var tenantId = TenantId.From(Guid.NewGuid());
        var principal = new AuthenticatedPrincipal(
            PrincipalId.Create(),
            tenantId,
            PrincipalStatus.Active,
            "Existing Person");
        var sessions = new FakeBrowserSessions();
        var handler = new CompleteBrowserSignInHandler(new FakeProvisioner(principal), sessions);
        var command = new CompleteBrowserSignIn(
            tenantId,
            "https://issuer.example.test",
            "subject-1",
            new UserInfoProfile(null, null, EmailVerified: false),
            principal,
            Session(tenantId, PrincipalId.Create()));

        var result = await handler.HandleAsync(command, TestContext.Current.CancellationToken);

        Assert.True(result.IsFailure);
        Assert.Equal("auth.session_invariant", result.Error.Code);
        Assert.Null(sessions.Added);
    }

    private static BrowserSession Session(TenantId tenantId, PrincipalId principalId)
    {
        var now = DateTimeOffset.UtcNow;
        return new BrowserSession
        {
            Id = BrowserSessionId.Create(),
            TenantId = tenantId,
            PrincipalId = principalId,
            TokenHash = new string('a', BrowserSession.TokenHashLength),
            CreatedAt = now,
            ExpiresAt = now.AddHours(8),
        };
    }

    private sealed class FakeProvisioner(AuthenticatedPrincipal result) : IPersonalWorkspaceProvisioner
    {
        public string? Subject { get; private set; }

        public UserInfoProfile? Profile { get; private set; }

        public ValueTask<AuthenticatedPrincipal> ProvisionAsync(
            TenantId tenantId,
            string issuer,
            string subject,
            UserInfoProfile profile,
            CancellationToken cancellationToken)
        {
            Subject = subject;
            Profile = profile;
            return ValueTask.FromResult(result);
        }
    }

    private sealed class FakeBrowserSessions : IBrowserSessions
    {
        public BrowserSession? Added { get; private set; }

        public CancellationToken CancellationToken { get; private set; }

        public ValueTask<AuthenticatedBrowserSession?> FindByTokenHashAsync(
            string tokenHash,
            CancellationToken cancellationToken) => ValueTask.FromResult<AuthenticatedBrowserSession?>(null);

        public ValueTask<AuthenticatedBrowserSession?> FindByIdAsync(
            BrowserSessionId id,
            CancellationToken cancellationToken) => ValueTask.FromResult<AuthenticatedBrowserSession?>(null);

        public ValueTask AddAsync(BrowserSession session, CancellationToken cancellationToken)
        {
            Added = session;
            CancellationToken = cancellationToken;
            return ValueTask.CompletedTask;
        }

        public ValueTask<bool> RevokeAsync(
            BrowserSessionId id,
            DateTimeOffset revokedAt,
            CancellationToken cancellationToken) => ValueTask.FromResult(false);
    }
}
