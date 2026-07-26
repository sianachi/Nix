namespace Nix.Api.Features.Items;

/// <summary>
/// Creates an item in a workspace.
/// </summary>
/// <param name="Type">The kind to create - <c>folder</c>, <c>note</c>, <c>task</c>, <c>board</c>.</param>
/// <param name="Title">The display name.</param>
/// <param name="ParentId">
/// The parent to create it under, or <see langword="null"/> to create it at the workspace root.
/// </param>
/// <remarks>
/// No client-supplied identifier and no sequence number. The server mints the identifier so it can
/// be time-ordered, and places the item among its siblings itself; a client that could choose
/// either would be able to collide with one it cannot see.
/// </remarks>
internal sealed record CreateItemRequest(string Type, string Title, Guid? ParentId);
