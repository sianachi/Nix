namespace Nix.Features.Permissions;

/// <summary>
/// Grants or refuses a role to a subject on an item, replacing any entry that subject already has
/// with the same effect.
/// </summary>
/// <param name="SubjectType"><c>principal</c> or <c>group</c>.</param>
/// <param name="SubjectId">The subject's identifier.</param>
/// <param name="Role">The role to grant or refuse.</param>
/// <param name="Effect"><c>allow</c> or <c>deny</c>.</param>
/// <param name="BreaksInheritance">Whether resolution should stop climbing at this item.</param>
/// <remarks>
/// An upsert rather than a create, because "share this with Ada as editor" is the same intent
/// whether or not Ada already had a role - and a client that had to discover which by trying
/// would race with anyone else editing the same panel.
/// </remarks>
internal sealed record UpsertAclEntryRequest(
    string SubjectType,
    Guid SubjectId,
    string Role,
    string Effect,
    bool BreaksInheritance);
