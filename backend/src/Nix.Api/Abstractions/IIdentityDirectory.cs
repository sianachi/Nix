using Nix.Domain.Identity;
using Nix.Domain.Tenancy;

namespace Nix.Abstractions;

/// <summary>
/// The two lookups authentication needs, both of which happen before a tenant is known.
/// </summary>
/// <remarks>
/// <para>
/// This port exists because these are the only reads in the system that cannot be tenant-scoped:
/// the tenant is what they are looking for. Both go through the security-definer function the M0
/// migration created (see ADR-0003), which is the one narrow hole in the isolation policy - exact
/// match on issuer and audience, enabled registrations only, at most one row, no way to enumerate.
/// </para>
/// <para>
/// Everything after these two calls runs inside a normal tenant-scoped unit of work.
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
    /// <param name="externalSubject">The token's <c>sub</c> claim.</param>
    /// <param name="cancellationToken">Cancels the lookup.</param>
    /// <returns>
    /// The principal, or <see langword="null"/> when the subject is not provisioned. Absence is a
    /// refusal, never an invitation to create one: provisioning is SCIM's job, and a token alone
    /// must not be able to mint an identity.
    /// </returns>
    public ValueTask<AuthenticatedPrincipal?> FindPrincipalAsync(
        TenantId tenantId,
        string externalSubject,
        CancellationToken cancellationToken);
}

/// <summary>What token validation needs to know about a registered issuer.</summary>
/// <param name="TenantId">The tenant that registered it.</param>
/// <param name="Issuer">The expected <c>iss</c>.</param>
/// <param name="Audience">The expected <c>aud</c>.</param>
/// <param name="JwksUri">Where the signing keys are published.</param>
/// <param name="AllowedAlgorithms">The signing algorithms accepted from this issuer.</param>
public sealed record IdentityProviderRegistration(
    TenantId TenantId,
    string Issuer,
    string Audience,
    Uri JwksUri,
    IReadOnlyList<string> AllowedAlgorithms);

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
