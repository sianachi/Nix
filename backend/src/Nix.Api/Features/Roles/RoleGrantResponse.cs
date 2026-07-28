namespace Nix.Features.Roles;

/// <summary>
/// One role held by a principal or a group, at tenant or workspace level.
/// </summary>
/// <param name="SubjectType"><c>principal</c> or <c>group</c>.</param>
/// <param name="SubjectId">The holder's identifier.</param>
/// <param name="SubjectDisplayName">The holder's name, so a member list renders in one request.</param>
/// <param name="Role">The role held.</param>
/// <param name="GrantedAt">When it was granted.</param>
/// <remarks>
/// One shape for both levels rather than two near-identical ones. What differs between a tenant
/// role and a workspace role is the collection it appears in, which the URL already says; the row
/// itself is the same question - who holds what, and since when.
/// </remarks>
internal sealed record RoleGrantResponse(
    string SubjectType,
    Guid SubjectId,
    string SubjectDisplayName,
    string Role,
    DateTimeOffset GrantedAt);
