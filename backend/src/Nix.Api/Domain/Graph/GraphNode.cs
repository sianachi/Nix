using Nix.Domain.Items;

namespace Nix.Domain.Graph;

/// <summary>
/// One item as a graph drawing needs it: something to label, something to place, and nothing else.
/// </summary>
/// <param name="Id">The item.</param>
/// <param name="ParentId">
/// The item's parent when that parent is also a node in the same reading, and
/// <see langword="null"/> otherwise - either because the item sits at the workspace root, or
/// because the parent fell outside the node ceiling. A parent identifier pointing at a node the
/// payload does not carry is an edge a client would draw into nothing.
/// </param>
/// <param name="Type">How the item's own body is drawn.</param>
/// <param name="Title">What it is called, or <see langword="null"/> when it has never been named.</param>
/// <param name="CreatedAt">When the item was created. What a time-lapse orders the drawing by.</param>
/// <param name="LastModifiedAt">
/// When the item was last modified, or <see langword="null"/> when the item is locked or sits under
/// a lock. The moment a locked item last changed is a record of activity behind the lock: it
/// would say that somebody is working there, and when. Withheld for a credential that
/// holds the lock open too, like every other body-derived answer in the graph.
/// </param>
/// <remarks>
/// <para>
/// Deliberately not <see cref="ItemDigest"/>. A digest carries the workspace identifier, which is
/// the same value on every node of a workspace graph, and carries no parent, which is the one
/// structural fact a graph is drawn from. Six columns on two thousand rows is worth its own
/// projection.
/// </para>
/// <para>
/// <b>A node exists only for an item the caller may read.</b> Nothing constructs one to stand in
/// for an item they may not: a placeholder in a graph is worse than a placeholder in a list,
/// because its edges describe the shape of what is being hidden.
/// </para>
/// </remarks>
public sealed record GraphNode(
    ItemId Id,
    ItemId? ParentId,
    string Type,
    string? Title,
    DateTimeOffset CreatedAt,
    DateTimeOffset? LastModifiedAt);
