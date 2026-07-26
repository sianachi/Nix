namespace Nix.Api.Features.Permissions;

/// <summary>
/// One access control entry on an item.
/// </summary>
/// <param name="Id">The entry's identifier.</param>
/// <param name="ItemId">The item it is attached to.</param>
/// <param name="SubjectType">Whether the subject is a <c>principal</c> or a <c>group</c>.</param>
/// <param name="SubjectId">The subject's identifier.</param>
/// <param name="SubjectDisplayName">
/// The subject's name, so a permissions panel can render the entry without a second round trip per
/// row.
/// </param>
/// <param name="Role">The role granted or refused.</param>
/// <param name="Effect"><c>allow</c> or <c>deny</c>.</param>
/// <param name="BreaksInheritance">Whether resolution stops climbing at this item.</param>
/// <param name="InheritedFromItemId">
/// The ancestor this entry is attached to when it applies by inheritance, or
/// <see langword="null"/> when it sits on the item itself.
/// </param>
/// <remarks>
/// <see cref="InheritedFromItemId"/> is what lets a sharing panel tell "shared here" from "shared
/// on a folder above", which is the single most confusing thing about inherited permissions and
/// the one a user most needs shown. The server computes it; the client never walks a tree to work
/// it out.
/// </remarks>
internal sealed record AclEntryResponse(
    Guid Id,
    Guid ItemId,
    string SubjectType,
    Guid SubjectId,
    string SubjectDisplayName,
    string Role,
    string Effect,
    bool BreaksInheritance,
    Guid? InheritedFromItemId);
