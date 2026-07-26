namespace Nix.Api.Features.Items;

/// <summary>
/// Changes an item's own fields. Moving and deleting have their own operations.
/// </summary>
/// <param name="Title">The new display name.</param>
/// <remarks>
/// Deliberately narrow. Reparenting is <c>POST /items/{itemId}/move</c> and deletion is
/// <c>DELETE</c>, because both have consequences - closure maintenance, cycle rejection, subtree
/// visibility - that a general-purpose patch would hide behind a field assignment. An endpoint
/// whose failure modes depend on which fields the caller happened to include is one nobody can
/// reason about.
/// </remarks>
internal sealed record UpdateItemRequest(string Title);
