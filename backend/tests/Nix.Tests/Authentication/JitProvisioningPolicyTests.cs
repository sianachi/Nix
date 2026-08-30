using Nix.Abstractions;
using Nix.Authentication;
using Nix.Domain.Identity;
using Nix.Domain.Tenancy;

namespace Nix.Tests.Authentication;

public sealed class JitProvisioningPolicyTests
{
    [Fact]
    public void Core_issued_pat_sessions_can_never_provision()
    {
        var token = new ValidatedCoreToken(
            TenantId.From(Guid.NewGuid()),
            PrincipalId.Create(),
            PersonalAccessTokenId.Create());

        Assert.Null(JitProvisioningPolicy.EligibleRegistration(token));
    }

    [Theory]
    [InlineData(false, true, true)]
    [InlineData(true, false, true)]
    [InlineData(true, true, false)]
    public void External_sessions_require_enabled_jit_userinfo_and_an_exact_authorized_party(
        bool jitEnabled,
        bool hasUserInfo,
        bool hasAuthorizedParty)
    {
        var registration = Registration(jitEnabled, hasUserInfo);
        var token = new ValidatedExternalToken(
            registration.TenantId,
            "subject",
            registration,
            hasAuthorizedParty ? registration : null);

        Assert.Null(JitProvisioningPolicy.EligibleRegistration(token));
    }

    [Fact]
    public void The_exact_enabled_authorized_party_registration_is_returned()
    {
        var registration = Registration(jitEnabled: true, hasUserInfo: true);
        var token = new ValidatedExternalToken(
            registration.TenantId,
            "subject",
            registration,
            registration);

        Assert.Same(registration, JitProvisioningPolicy.EligibleRegistration(token));
    }

    private static IdentityProviderRegistration Registration(bool jitEnabled, bool hasUserInfo) =>
        new(
            TenantId.From(Guid.NewGuid()),
            "https://issuer.example.test",
            "web",
            new Uri("https://issuer.example.test/keys"),
            ["RS256"],
            IdentityProviderId.Create(),
            jitEnabled,
            hasUserInfo ? new Uri("https://issuer.example.test/userinfo") : null);
}
