namespace Nix.Features.Bookmarks;

/// <summary>One item on the caller's shelf.</summary>
/// <param name="ItemId">The item kept.</param>
/// <param name="Title">
/// What it is called, or <see langword="null"/> when it has never been named. Read from the item
/// rather than stored on the bookmark, so a rename shows here immediately.
/// </param>
/// <param name="Type">How the item's own body is drawn, so a list can say what kind of thing it is.</param>
/// <param name="WorkspaceId">
/// Which workspace it lives in. A shelf crosses workspaces, and an item that cannot say where it
/// lives is a title with no context.
/// </param>
/// <param name="KeptAt">When it was kept.</param>
internal sealed record KeptItemResponse(
    Guid ItemId,
    string? Title,
    string Type,
    Guid WorkspaceId,
    DateTimeOffset KeptAt);

/// <summary>Everything the caller has kept.</summary>
/// <param name="Items">
/// The kept items, most recently kept first, and only those the caller may still read.
/// </param>
/// <param name="Hidden">
/// How many kept items are not in <paramref name="Items"/> because the caller can no longer read
/// them.
/// </param>
/// <remarks>
/// <b>The count is what makes the omission honest without disclosing anything.</b> A bookmark
/// outlives access to what it points at, so a shelf can hold rows the reader may no longer open. A
/// list that silently dropped them would be a shelf that lost things without saying so; a list that
/// named them would disclose the titles of documents somebody has been removed from. A number does
/// neither - it says the shelf is larger than what is shown, and stops there.
/// </remarks>
internal sealed record ShelfResponse(IReadOnlyList<KeptItemResponse> Items, int Hidden);
