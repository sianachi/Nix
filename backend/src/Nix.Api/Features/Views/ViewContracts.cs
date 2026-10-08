namespace Nix.Features.Views;

/// <summary>
/// One named way of looking at a container.
/// </summary>
/// <param name="Id">Stable across renames, because a shared link names it.</param>
/// <param name="Name">What a person sees in the switcher.</param>
/// <param name="Kind">
/// One of the kinds <see cref="Nix.Domain.Views.ViewKinds.All"/> defines - not listed here, because
/// a list written out in a comment is one a new kind can leave wrong, and the published sentence is
/// generated from that table by <see cref="ViewKindProse"/>. An open string rather than an enum: a
/// kind a client has not been rebuilt for should leave it offering fewer views, not failing to
/// parse the set.
/// </param>
/// <param name="Columns">
/// List views: the property keys to show, in order. Empty means the effective schema decides.
/// </param>
/// <param name="GroupBy">
/// Board views: the single-select property whose values become columns. List views: the select or
/// checkbox property, or <c>$type</c> for each item's body kind, whose values become sections.
/// </param>
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
/// <param name="Measure">
/// For a chart: what each bar measures - <c>count</c> or <c>sum</c>. Null means <c>count</c>, which
/// is what a chart with nothing configured draws.
/// </param>
/// <param name="MeasureProperty">
/// For a chart totalling a property: which numeric property is totalled per bucket.
/// </param>
/// <param name="CardSize">
/// Gallery views: how large each card is drawn - <c>small</c>, <c>medium</c> or <c>large</c>. Null
/// means <c>medium</c>, which is what every gallery stored before this field existed has always
/// looked like. Anything else is refused on write; the set is closed.
/// </param>
/// <param name="Filters">
/// The conditions a view's items must meet, AND-combined. Empty means no conditions - for a query
/// view, everything the reader can see, newest first. A query view compiles them across the
/// workspace; a list, board, calendar, timeline, gallery or sheet applies them to the container's
/// own children. A chart stores them without applying them (ADR-0054).
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
    string? EndDateProperty,
    string? CardSize,
    IReadOnlyList<FilterRuleContract> Filters,
    string? CompanionViewId,
    string? CompanionPlacement,
    InteractiveFormContract? InteractiveForm,
    string? Measure,
    string? MeasureProperty,
    IReadOnlyList<ViewSortContract> Sorts,
    IReadOnlyList<string> CollapsedGroups,
    IReadOnlyList<ViewGroupLimitContract> GroupLimits,
    IReadOnlyList<ViewAggregateContract> Aggregates,
    IReadOnlyList<HabitWidgetContract>? HabitWidgets = null,
    string? Layout = null);

/// <summary>One key a view orders by; the first is mirrored into <c>sortBy</c>.</summary>
/// <param name="Property">The property key, or <c>title</c>.</param>
/// <param name="Descending">Which way.</param>
internal sealed record ViewSortContract(string Property, bool Descending);

/// <summary>A soft limit on one group's size, shown and never enforced.</summary>
/// <param name="Group">The grouping property's stored value; empty for the "no value" group.</param>
/// <param name="Limit">From 1 to 999.</param>
internal sealed record ViewGroupLimitContract(string Group, int Limit);

/// <summary>The summary a list or sheet shows beneath one column.</summary>
/// <param name="Property">The property key.</param>
/// <param name="Function">
/// One of: <c>count</c>, <c>count-empty</c>, <c>count-filled</c>, <c>sum</c>, <c>average</c>,
/// <c>min</c>, <c>max</c>, <c>percent-checked</c>.
/// </param>
internal sealed record ViewAggregateContract(string Property, string Function);

/// <summary>One condition of a view's filter.</summary>
/// <param name="Property">The property key the condition tests, matched across containers.</param>
/// <param name="Operator">
/// One of: <c>equals</c>, <c>not-equals</c>, <c>on</c>, <c>before</c>, <c>on-or-after</c>,
/// <c>within-next</c>, <c>contains</c>, <c>not-contains</c>, <c>greater-than</c>, <c>less-than</c>,
/// <c>is-empty</c>, <c>is-not-empty</c>. A closed set, refused outside it. A query view may use only
/// the first six.
/// </param>
/// <param name="Value">
/// What the operator compares against: a literal for the equality pair; <c>today</c> or a
/// <c>yyyy-MM-dd</c> date for <c>on</c>/<c>before</c>/<c>on-or-after</c>; a day count from 1 to
/// 365 for <c>within-next</c>; a literal for <c>contains</c>/<c>not-contains</c>, matched as a
/// case-insensitive substring of text or as one multi-select option exactly; a finite invariant
/// number for <c>greater-than</c>/<c>less-than</c>; empty for <c>is-empty</c>/<c>is-not-empty</c>.
/// <c>today</c> is resolved at read time from the caller's own <c>today</c> parameter, so a saved
/// query stays a rule rather than a date.
/// </param>
/// <remarks>
/// Rules combine with AND. Whether the property exists is deliberately not checked - the query
/// spans containers, and a rule naming a property nothing declares simply matches nothing.
/// </remarks>
internal sealed record FilterRuleContract(string Property, string Operator, string Value);

internal sealed record FormConditionContract(string FieldBlockId, string Operator, string? Value);

internal sealed record FormBlockContract(
    string Id,
    string Kind,
    string? PropertyKey,
    string Text,
    string? Help,
    bool Required,
    string? IdentityRole,
    IReadOnlyList<FormConditionContract> VisibleWhen);

internal sealed record FormPageContract(
    string Id,
    string Title,
    string? Description,
    IReadOnlyList<FormConditionContract> VisibleWhen,
    IReadOnlyList<FormBlockContract> Blocks);

internal sealed record InteractiveFormContract(
    IReadOnlyList<FormPageContract> Pages,
    string TitleMode,
    string? TitleFieldBlockId,
    string ConfirmationTitle,
    string ConfirmationMessage);

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
/// a default naming a deleted view arrives as <c>document</c> rather than as a dangling id. While
/// the document tab is hidden it is never <c>document</c>: the first view stands in.
/// </param>
/// <param name="HideDocument">
/// Whether the item's own document tab is left out of its switcher. Always present. A hidden tab is
/// not a protected body: this is not an access control, and the body stays readable through every
/// body read, search, link and export.
/// </param>
/// <remarks>
/// <b><see cref="Unrenderable"/> is the honest-state field.</b> Without it, such a board renders as
/// an empty board, which is indistinguishable from an item with nothing in it and sends somebody looking for
/// missing items instead of a missing property.
/// </remarks>
internal sealed record ContainerViewsResponse(
    IReadOnlyList<ViewResponse> Views,
    IReadOnlyList<string> Unrenderable,
    string Default,
    bool HideDocument);

/// <summary>
/// Replaces every view a container offers.
/// </summary>
/// <param name="Views">The views, in switcher order.</param>
/// <param name="Default">
/// Which view should open: a view's id, or <c>document</c> (or absent) for the item's own body.
/// Refused when it names a view this request does not also contain.
/// </param>
/// <param name="HideDocument">
/// Whether to hide the item's own document tab. Absent leaves the stored flag as it is. True needs
/// at least one view in this request and is refused with <c>views.document_cannot_be_hidden</c>
/// otherwise; it makes the first view open when <paramref name="Default"/> is <c>document</c> or
/// absent. While the flag is stored, an explicit <c>document</c> default is refused with the same
/// code. A request that leaves no views clears the flag. This hides a tab only; it is not an
/// access control.
/// </param>
/// <remarks>
/// A whole-set replacement because the order is part of what is being edited, and reordering
/// through per-view endpoints is a sequence of writes that can half-apply.
/// </remarks>
internal sealed record SetViewsRequest(
    IReadOnlyList<ViewRequest> Views,
    string? Default,
    bool? HideDocument = null);

/// <summary>One view being configured. Mirrors <see cref="ViewResponse"/>.</summary>
/// <param name="Id">Stable across renames.</param>
/// <param name="Name">What a person sees.</param>
/// <param name="Kind">
/// One of the kinds <see cref="Nix.Domain.Views.ViewKinds.All"/> defines. See
/// <see cref="ViewResponse"/> for why they are not listed here.
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
/// <param name="CardSize">
/// Gallery views: <c>small</c>, <c>medium</c> or <c>large</c>, or null for <c>medium</c>. A value
/// outside the set is refused.
/// </param>
/// <param name="Filters">
/// Query views: the conditions to store, AND-combined; each is checked against the closed
/// operator grammar. Null and empty both mean no conditions.
/// </param>
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
    string? EndDateProperty,
    string? CardSize,
    IReadOnlyList<FilterRuleContract>? Filters,
    string? CompanionViewId,
    string? CompanionPlacement,
    InteractiveFormContract? InteractiveForm,
    string? Measure = null,
    string? MeasureProperty = null,
    IReadOnlyList<HabitWidgetContract>? HabitWidgets = null,
    string? Layout = null,
    IReadOnlyList<ViewSortContract>? Sorts = null,
    IReadOnlyList<string>? CollapsedGroups = null,
    IReadOnlyList<ViewGroupLimitContract>? GroupLimits = null,
    IReadOnlyList<ViewAggregateContract>? Aggregates = null);

/// <summary>A configured embedded habit chart.</summary>
internal sealed record HabitWidgetContract(string Id, string Kind, Guid HabitId, DateOnly From, DateOnly To);
