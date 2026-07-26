namespace Nix.Api.Features.Items;

/// <summary>
/// An item as the API presents it.
/// </summary>
/// <param name="Id">The item's identifier.</param>
/// <param name="WorkspaceId">The workspace it belongs to.</param>
/// <param name="ParentId">Its parent, or <see langword="null"/> for a workspace root.</param>
/// <param name="Type">Its kind - <c>folder</c>, <c>note</c>, <c>task</c>, <c>board</c>, <c>file</c>.</param>
/// <param name="Title">Its display name.</param>
/// <param name="Seq">Its position among its siblings.</param>
/// <param name="LifecycleState">Where it sits in the deletion lifecycle.</param>
/// <param name="CreatedAt">When it was created.</param>
/// <param name="UpdatedAt">When it was last modified.</param>
/// <remarks>
/// <para>
/// <b><see cref="Title"/> is a property, promoted.</b> The item table has no title column - a
/// name is one of the schema-driven properties an item carries, like any other. It is lifted to a
/// first-class field here because every client needs it to render a row and none of them should
/// have to reach into a property bag to find out what a thing is called. The goal that implements
/// items owns that mapping.
/// </para>
/// <para>
/// <b><see cref="Type"/> is an open string, not an enumeration.</b> Adding a kind of item should
/// be a feature rather than a breaking change to every generated client, so clients are expected
/// to render an unknown type generically instead of failing to parse it.
/// </para>
/// <para>
/// Properties themselves are absent from this shape on purpose. They arrive with property schemas
/// and their validation rules; publishing an untyped bag now would be a shape the client could not
/// usefully do anything with, and one that would change when the real thing lands.
/// </para>
/// </remarks>
internal sealed record ItemResponse(
    Guid Id,
    Guid WorkspaceId,
    Guid? ParentId,
    string Type,
    string Title,
    long Seq,
    string LifecycleState,
    DateTimeOffset CreatedAt,
    DateTimeOffset UpdatedAt);
