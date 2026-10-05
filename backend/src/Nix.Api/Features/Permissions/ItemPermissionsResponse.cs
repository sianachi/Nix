namespace Nix.Features.Permissions;

/// <summary>
/// Everything a sharing panel needs about one item's access, decided by the server.
/// </summary>
/// <param name="ItemId">The item.</param>
/// <param name="Entries">
/// The entries that apply, those on the item itself and those inherited from its ancestors.
/// </param>
/// <param name="EffectiveRole">
/// The role the calling principal actually holds on this item, after the full resolution order.
/// </param>
/// <param name="CanShare">
/// Whether the calling principal may change these permissions. The panel's controls are enabled
/// from this and from nothing else.
/// </param>
/// <param name="BreaksInheritance">Whether this item has been detached from its ancestors' entries.</param>
/// <remarks>
/// <para>
/// <b>The client computes nothing here.</b> <see cref="EffectiveRole"/> and <see cref="CanShare"/>
/// are answers, not inputs: there is exactly one implementation of the resolution order and it
/// lives in Core, so a client cannot reach a different conclusion from the same data - because it
/// is never given the data, only the conclusion. A frontend that derived "can this person share"
/// by inspecting <see cref="Entries"/> would be a second authorization implementation, and the
/// two would disagree eventually.
/// </para>
/// <para>
/// <see cref="Entries"/> is for display. Acting on it is always a request the server re-decides.
/// </para>
/// </remarks>
internal sealed record ItemPermissionsResponse(
    Guid ItemId,
    IReadOnlyList<AclEntryResponse> Entries,
    string EffectiveRole,
    bool CanShare,
    bool BreaksInheritance);
