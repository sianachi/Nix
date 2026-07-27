namespace Nix.Api.Features.Views;

/// <summary>
/// One named way of looking at a container.
/// </summary>
/// <param name="Id">Stable across renames, because a shared link names it.</param>
/// <param name="Name">What a person sees in the switcher.</param>
/// <param name="Kind">One of <c>list</c>, <c>board</c>, <c>calendar</c>.</param>
/// <param name="Columns">
/// List views: the property keys to show, in order. Empty means the effective schema decides.
/// </param>
/// <param name="GroupBy">Board views: the single-select property whose values become columns.</param>
/// <param name="GroupOrder">
/// Board views: which of that property's values to show, in which order. Empty means all of them.
/// Deliberately independent of the property's declared options - a board may show three of six
/// statuses.
/// </param>
/// <param name="DateProperty">Calendar views: the date property that places an item.</param>
/// <param name="SortBy">The property key to order by, or null for sibling order.</param>
/// <param name="SortDescending">Which way to order.</param>
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
    bool SortDescending);

/// <summary>
/// The views a container offers.
/// </summary>
/// <param name="Views">The views, in switcher order.</param>
/// <param name="Unrenderable">
/// Identifiers of views whose configured property no longer exists or no longer fits - a board
/// grouping by a property somebody deleted, say.
/// </param>
/// <remarks>
/// <b><see cref="Unrenderable"/> is the honest-state field.</b> Without it, such a board renders as
/// an empty board, which is indistinguishable from an empty folder and sends somebody looking for
/// missing items instead of a missing property.
/// </remarks>
internal sealed record ContainerViewsResponse(
    IReadOnlyList<ViewResponse> Views,
    IReadOnlyList<string> Unrenderable);

/// <summary>
/// Replaces every view a container offers.
/// </summary>
/// <param name="Views">The views, in switcher order.</param>
/// <remarks>
/// A whole-set replacement because the order is part of what is being edited, and reordering
/// through per-view endpoints is a sequence of writes that can half-apply.
/// </remarks>
internal sealed record SetViewsRequest(IReadOnlyList<ViewRequest> Views);

/// <summary>One view being configured. Mirrors <see cref="ViewResponse"/>.</summary>
/// <param name="Id">Stable across renames.</param>
/// <param name="Name">What a person sees.</param>
/// <param name="Kind">One of <c>list</c>, <c>board</c>, <c>calendar</c>.</param>
/// <param name="Columns">List views: the property keys to show.</param>
/// <param name="GroupBy">Board views: the property to group by.</param>
/// <param name="GroupOrder">Board views: which values to show, in which order.</param>
/// <param name="DateProperty">Calendar views: the date property.</param>
/// <param name="SortBy">The property key to order by.</param>
/// <param name="SortDescending">Which way to order.</param>
internal sealed record ViewRequest(
    string Id,
    string Name,
    string Kind,
    IReadOnlyList<string>? Columns,
    string? GroupBy,
    IReadOnlyList<string>? GroupOrder,
    string? DateProperty,
    string? SortBy,
    bool SortDescending);
