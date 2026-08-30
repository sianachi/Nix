using Nix.Abstractions;

namespace Nix.Authentication;

/// <summary>Fail-closed admission policy for first-login provisioning.</summary>
public static class JitProvisioningPolicy
{
    /// <summary>Returns the exact signed authorized-party registration allowed to provision.</summary>
    public static IdentityProviderRegistration? EligibleRegistration(ValidatedToken token) =>
        token is ValidatedExternalToken
        {
            AuthorizedPartyRegistration:
            {
                JitProvisioningEnabled: true,
                UserInfoUri: not null,
            } authorizedParty,
        }
            ? authorizedParty
            : null;
}
