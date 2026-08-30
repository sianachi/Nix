using Nix.Domain.Tenancy;

namespace Nix.Domain.Identity;

/// <summary>
/// An OIDC issuer a tenant has registered. Authentication resolves a token's <c>iss</c> and
/// <c>aud</c> against this table before anything else happens.
/// </summary>
/// <remarks>
/// <para>
/// A token whose issuer is not registered here is rejected outright and never just-in-time
/// mapped to a tenant. That is the whole reason this is a table rather than configuration: the
/// set of trusted issuers is per-tenant data, and adding one is an administrative act with an
/// audit trail, not a redeploy.
/// </para>
/// <para>
/// A tenant may register more than one - migrating between providers, or running a separate issuer
/// for service identities - so resolution matches on the pair and not on the tenant alone.
/// </para>
/// </remarks>
public sealed class IdentityProvider
{
    /// <summary>The maximum stored UserInfo URI length in UTF-8 bytes.</summary>
    public const int MaximumUserInfoUriLength = 2048;

    /// <summary>Gets the registration's identifier.</summary>
    public required IdentityProviderId Id { get; init; }

    /// <summary>Gets the owning tenant.</summary>
    public required TenantId TenantId { get; init; }

    /// <summary>Gets the expected <c>iss</c> claim.</summary>
    public required string Issuer { get; init; }

    /// <summary>Gets the expected <c>aud</c> claim.</summary>
    public required string Audience { get; init; }

    /// <summary>Gets where the issuer's signing keys are published.</summary>
    public required Uri JwksUri { get; init; }

    /// <summary>
    /// Gets the signing algorithms accepted from this issuer.
    /// </summary>
    /// <remarks>
    /// <para>
    /// An allowlist rather than a single value, and stored as an array rather than a delimited
    /// string, because a rotation runs two algorithms briefly and because "which algorithms does
    /// this issuer accept" should be answerable by a query rather than by string splitting. An
    /// empty allowlist accepts nothing, which is the correct reading of "no algorithm is
    /// permitted" and fails closed.
    /// </para>
    /// <para>
    /// Exposed as a read-only list rather than an array so a caller cannot rewrite the set of
    /// algorithms this issuer's tokens will be checked against by assigning into it. The mapping
    /// to Postgres <c>text[]</c> is one conversion in the entity configuration, which is the right
    /// place for the storage shape to differ from the domain's.
    /// </para>
    /// </remarks>
    public required IReadOnlyList<string> AllowedAlgorithms { get; init; }

    /// <summary>
    /// Gets a value indicating whether tokens from this issuer are currently accepted.
    /// </summary>
    /// <remarks>
    /// Disabling is reversible and keeps the registration's history; deleting it does not. An
    /// operator revoking trust in a hurry wants the former.
    /// </remarks>
    public required bool Enabled { get; init; }

    /// <summary>Gets whether this registration may provision a missing human principal.</summary>
    public required bool JitProvisioningEnabled { get; init; }

    /// <summary>Gets the bounded OIDC UserInfo endpoint used by JIT provisioning.</summary>
    public Uri? UserInfoUri { get; init; }
}
