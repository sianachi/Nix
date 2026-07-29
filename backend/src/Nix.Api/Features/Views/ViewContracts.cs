namespace Nix.Features.Views;

/// <summary>
/// One named way of looking at a container.
/// </summary>
/// <param name="Id">Stable across renames, because a shared link names it.</param>
/// <param name="Name">What a person sees in the switcher.</param>
/// <param name="Kind">
/// One of <c>list</c>, <c>board</c>, <c>calendar</c>, <c>gallery</c>, <c>timeline</c>. An open
/// string rather than an enum: a kind a client has not been rebuilt for should leave it offering
/// fewer views, not failing to parse the set.
/// </param>
/// <param name="Columns">
/// List views: the property keys to show, in order. Empty means the effective schema decides.
/// </param>
/// <param name="GroupBy">Board views: the single-select property whose values become columns.</param>
/// <param name="GroupOrder">
/// Board views: which of that property's values to show, in which order. Empty means all of them.
/// Deliberately independent of the property's declared options - a board may show three of six
/// statuses.
/// </param>
/// <param name="DateProperty">
/// Calendar views: the date property that places an item. Timeline views: the date a bar starts on.
/// </param>
/// <param name="SortBy">The property key to order by, or null for sibling order.</param>
/// <param name="SortDescending">Which way to order.</param>
/// <param name="Mode">
/// Calendar views: <c>month</c>, <c>week</c> or <c>day</c>. Timeline views: <c>week</c>,
/// <c>month</c> or <c>quarter</c>.
/// </param>
/// <param name="CoverProperty">
/// Gallery views: the image property each card shows as its cover, or null for a grid of titled
/// cards. Not a requirement - a gallery without one still draws every item.
/// </param>
/// <param name="EndDateProperty">
/// Timeline views: the date a bar ends on, or null. Not a requirement either - an item with a start
/// and no end is a milestone, and a timeline of milestones is still a timeline. An end that falls
/// before its start is stored as it is and reported by the view; two independent property writes
/// cannot both be valid at every instant.
/// </param>
/// <remarks>
/// <b>There is no placement or layout field, and there will not be one.</b> Where a card sits is
/// its property value and its sibling order - never a coordinate stored against a view. That is
/// what makes dragging a card an edit everybody sees, in every view, rather than a change to how
/// one person happens to be looking at it.
/// </remarks>
internal sealed record ViewResponse(
    string Id,
    string Name,
    string Kind,
    IReadOnlyList<string> Columns,
    string? GroupBy,
    IReadOnlyList<string> GroupOrder,
    string? DateProperty,
    string? SortBy,
    bool SortDescending,
    string? Mode,
    string? CoverProperty,
    string? EndDateProperty);

/// <summary>
/// The views a container offers.
/// </summary>
/// <param name="Views">The views, in switcher order.</param>
/// <param name="Unrenderable">
/// Identifiers of views whose configured property no longer exists or no longer fits - a board
/// grouping by a property somebody deleted, say.
/// </param>
/// <param name="Default">
/// Which view opens: a view's id, or <c>document</c> for the item's own body. Already resolved, so
/// a default naming a deleted view arrives as <c>document</c> rather than as a dangling id.
/// </param>
/// <remarks>
/// <b><see cref="Unrenderable"/> is the honest-state field.</b> Without it, such a board renders as
/// an empty board, which is indistinguishable from an item with nothing in it and sends somebody looking for
/// missing items instead of a missing property.
/// </remarks>
internal sealed record ContainerViewsResponse(
    IReadOnlyList<ViewResponse> Views,
    IReadOnlyList<string> Unrenderable,
    string Default);

/// <summary>
/// Replaces every view a container offers.
/// </summary>
/// <param name="Views">The views, in switcher order.</param>
/// <param name="Default">
/// Which view should open: a view's id, or <c>document</c> (or absent) for the item's own body.
/// Refused when it names a view this request does not also contain.
/// </param>
/// <remarks>
/// A whole-set replacement because the order is part of what is being edited, and reordering
/// through per-view endpoints is a sequence of writes that can half-apply.
/// </remarks>
internal sealed record SetViewsRequest(IReadOnlyList<ViewRequest> Views, string? Default);

/// <summary>One view being configured. Mirrors <see cref="ViewResponse"/>.</summary>
/// <param name="Id">Stable across renames.</param>
/// <param name="Name">What a person sees.</param>
/// <param name="Kind">
/// One of <c>list</c>, <c>board</c>, <c>calendar</c>, <c>gallery</c>, <c>timeline</c>.
/// </param>
/// <param name="Columns">List views: the property keys to show.</param>
/// <param name="GroupBy">Board views: the property to group by.</param>
/// <param name="GroupOrder">Board views: which values to show, in which order.</param>
/// <param name="DateProperty">
/// Calendar views: the date property. Timeline views: the date a bar starts on.
/// </param>
/// <param name="SortBy">The property key to order by.</param>
/// <param name="SortDescending">Which way to order.</param>
/// <param name="Mode">
/// Calendar views: <c>month</c>, <c>week</c> or <c>day</c>. Timeline views: <c>week</c>,
/// <c>month</c> or <c>quarter</c>.
/// </param>
/// <param name="CoverProperty">Gallery views: the image property each card shows as its cover.</param>
/// <param name="EndDateProperty">Timeline views: the date a bar ends on, or null for a milestone.</param>
internal sealed record ViewRequest(
    string Id,
    string Name,
    string Kind,
    IReadOnlyList<string>? Columns,
    string? GroupBy,
    IReadOnlyList<string>? GroupOrder,
    string? DateProperty,
    string? SortBy,
    bool SortDescending,
    string? Mode,
    string? CoverProperty,
    string? EndDateProperty);
