using Nix.Domain.Identity;
using Nix.Domain.Tenancy;

namespace Nix.Abstractions;

/// <summary>
/// Resolves trusted external registrations and the principals named by validated sessions.
/// </summary>
/// <remarks>
/// <para>
/// Provider resolution is the one read that happens before a tenant is known: exact issuer and
/// audience select an enabled registration and its JIT/UserInfo policy. The two principal lookups
/// happen only after that tenant is known. External sessions resolve by exact issuer and subject;
/// Core-issued sessions resolve directly by principal identifier. Each read uses its own narrow
/// security-definer function (see ADR-0003 and ADR-0045), with no enumeration surface.
/// </para>
/// <para>
/// Everything after registration resolution runs inside a normal tenant-scoped unit of work.
/// </para>
/// </remarks>
public interface IIdentityDirectory
{
    /// <summary>
    /// Resolves a token's issuer and audience to the tenant that registered them.
    /// </summary>
    /// <param name="issuer">The token's <c>iss</c> claim.</param>
    /// <param name="audience">The token's <c>aud</c> claim.</param>
    /// <param name="cancellationToken">Cancels the lookup.</param>
    /// <returns>
    /// The registration, or <see langword="null"/> when no enabled one matches. A token from an
    /// unregistered issuer is rejected outright and never just-in-time mapped to a tenant.
    /// </returns>
    public ValueTask<IdentityProviderRegistration?> ResolveProviderAsync(
        string issuer,
        string audience,
        CancellationToken cancellationToken);

    /// <summary>
    /// Finds the principal a token's subject belongs to, within the tenant already resolved.
    /// </summary>
    /// <param name="tenantId">The tenant the provider resolved to.</param>
    /// <param name="externalIssuer">The exact registered issuer that validated the token.</param>
    /// <param name="externalSubject">The token's <c>sub</c> claim.</param>
    /// <param name="cancellationToken">Cancels the lookup.</param>
    /// <returns>
    /// The principal, or <see langword="null"/> when the issuer-qualified subject is not yet
    /// provisioned. A caller may provision only when the already-validated external token's exact
    /// authorized-party registration explicitly enables JIT; this lookup itself never creates.
    /// </returns>
    public ValueTask<AuthenticatedPrincipal?> FindExternalPrincipalAsync(
        TenantId tenantId,
        string externalIssuer,
        string externalSubject,
        CancellationToken cancellationToken);

    /// <summary>Finds the principal identifier named directly by a Core-issued PAT session.</summary>
    /// <param name="tenantId">The tenant claim signed by Core.</param>
    /// <param name="principalId">The principal identifier claim signed by Core.</param>
    /// <param name="cancellationToken">Cancels the lookup.</param>
    /// <returns>The matching tenant-scoped principal, or <see langword="null"/>.</returns>
    public ValueTask<AuthenticatedPrincipal?> FindPrincipalByIdAsync(
        TenantId tenantId,
        PrincipalId principalId,
        CancellationToken cancellationToken);
}

/// <summary>What token validation needs to know about a registered issuer.</summary>
/// <param name="TenantId">The tenant that registered it.</param>
/// <param name="Issuer">The expected <c>iss</c>.</param>
/// <param name="Audience">The expected <c>aud</c>.</param>
/// <param name="JwksUri">Where the signing keys are published.</param>
/// <param name="AllowedAlgorithms">The signing algorithms accepted from this issuer.</param>
/// <param name="ProviderId">The durable registration identifier.</param>
/// <param name="JitProvisioningEnabled">Whether this exact registration may trigger JIT.</param>
/// <param name="UserInfoUri">The bounded UserInfo endpoint required when JIT is enabled.</param>
public sealed record IdentityProviderRegistration(
    TenantId TenantId,
    string Issuer,
    string Audience,
    Uri JwksUri,
    IReadOnlyList<string> AllowedAlgorithms,
    IdentityProviderId ProviderId,
    bool JitProvisioningEnabled,
    Uri? UserInfoUri);

/// <summary>The principal behind a validated token.</summary>
/// <param name="Id">The principal.</param>
/// <param name="TenantId">Their tenant.</param>
/// <param name="Status">
/// Whether they may act. Checked on every request rather than only at sign-in, because an access
/// token outlives the decision to revoke it - which is what makes deprovisioning fail closed
/// immediately instead of at the next token exchange.
/// </param>
/// <param name="DisplayName">Their name, for the shell.</param>
public sealed record AuthenticatedPrincipal(
    PrincipalId Id,
    TenantId TenantId,
    PrincipalStatus Status,
    string DisplayName);
