using System.Diagnostics.CodeAnalysis;
using Nix.Core.Tenancy;

namespace Nix.Core.Identity;

/// <summary>
/// An identity provisioned from a tenant's identity provider. A principal is not an item and is
/// never addressable as one.
/// </summary>
/// <remarks>
/// <para>
/// The database is the authority on who a principal is and what they may do. Tokens carry identity
/// and nothing else - no roles, no permissions - because a token is a bearer artefact minted
/// minutes ago by a system we do not control, and a role inside one cannot be revoked before it
/// expires. Group claims are provisioning input only.
/// </para>
/// <para>
/// <see cref="ExternalSubject"/> is the issuer's stable subject identifier, not an email address.
/// Email changes when someone marries; the subject does not.
/// </para>
/// </remarks>
[SuppressMessage(
    "Naming",
    "CA1724:Type names should not match namespaces",
    // Justification: "principal" is the specification's word for this concept and appears in the
    // entity model, the authorization rules, and the session context. Renaming the type to dodge a
    // partial collision with System.Security.Principal would put the code's vocabulary out of step
    // with the document every reader checks it against, and nothing here imports that namespace -
    // the ASP.NET identity types are a different concept that this one deliberately does not use.
    Justification = "Domain term fixed by the specification; no file imports System.Security.Principal.")]
public sealed class Principal
{
    /// <summary>Gets the principal's identifier.</summary>
    public required PrincipalId Id { get; init; }

    /// <summary>Gets the owning tenant.</summary>
    public required TenantId TenantId { get; init; }

    /// <summary>
    /// Gets the identity provider's stable subject claim for this identity.
    /// </summary>
    public required string ExternalSubject { get; init; }

    /// <summary>Gets whether this is a person or a machine identity.</summary>
    public required PrincipalKind Kind { get; init; }

    /// <summary>Gets the name shown in the interface.</summary>
    public required string DisplayName { get; init; }

    /// <summary>
    /// Gets the principal's email address, or <see langword="null"/> when the provider supplies
    /// none. Service identities usually have none, and a person's is a display and notification
    /// concern rather than an identifier.
    /// </summary>
    public string? Email { get; init; }

    /// <summary>Gets whether the principal may currently act.</summary>
    public required PrincipalStatus Status { get; init; }

    /// <summary>
    /// Gets when deprovisioning was recorded, or <see langword="null"/> if it has not been.
    /// </summary>
    /// <remarks>
    /// Kept alongside <see cref="Status"/> rather than inferred from it, because "when did this
    /// person lose access" is a question compliance asks and a status flag cannot answer.
    /// </remarks>
    public DateTimeOffset? DeprovisionedAt { get; init; }
}
