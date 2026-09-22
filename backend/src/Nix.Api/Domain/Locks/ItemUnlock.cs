using Nix.Domain.Identity;
using Nix.Domain.Items;
using Nix.Domain.Tenancy;

namespace Nix.Domain.Locks;

/// <summary>
/// A short-lived grant that lets one credential read one locked item's body.
/// </summary>
/// <remarks>
/// <para>
/// <b>Keyed by credential, not by principal.</b> Unlocking a note in one browser must not unlock it
/// in every other browser, command-line session or token the same person holds - the lock exists
/// for the moment somebody walks away from a screen, and a grant that followed the principal would
/// follow them to the screen they walked away from. The credential is the browser session or the
/// personal access token the request authenticated with.
/// </para>
/// <para>
/// The row expires rather than being revoked by a job: every read compares
/// <see cref="ExpiresAt"/> with the clock, so an expired grant is inert whether or not it has been
/// swept.
/// </para>
/// </remarks>
public sealed class ItemUnlock
{
    /// <summary>Gets the unlocked item.</summary>
    public required ItemId ItemId { get; init; }

    /// <summary>Gets the browser session or personal access token the grant belongs to.</summary>
    public required Guid CredentialId { get; init; }

    /// <summary>Gets the tenant the item belongs to.</summary>
    public required TenantId TenantId { get; init; }

    /// <summary>Gets the principal who presented the password.</summary>
    public required PrincipalId PrincipalId { get; init; }

    /// <summary>Gets when the grant stops being honoured.</summary>
    public required DateTimeOffset ExpiresAt { get; init; }
}
