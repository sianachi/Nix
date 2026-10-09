using System.Text.Json.Nodes;
using Nix.Features.Views;

namespace Nix.Features.Query;

/// <summary>Where an ad-hoc query looks.</summary>
/// <param name="ParentId">
/// The container to look beneath, or null for the whole workspace. A container the caller cannot
/// read answers the same 404 an item read gives; a locked one answers 423 until it is unlocked.
/// </param>
/// <param name="Descendants">
/// True (the default) for everything beneath the container, at any depth; false for its direct
/// children only.
/// </param>
internal sealed record QueryScopeContract(Guid? ParentId, bool? Descendants);

/// <summary>How an ad-hoc query's rows are ordered.</summary>
/// <param name="Property">
/// A property key (compared as text, or by day for <c>due_date</c>), or one of <c>$created</c>,
/// <c>$modified</c>, <c>$type</c>. Empty values sort last either way.
/// </param>
/// <param name="Descending">True for largest or latest first.</param>
internal sealed record QuerySortContract(string? Property, bool? Descending);

/// <summary>How an ad-hoc query's rows or aggregate are grouped.</summary>
/// <param name="Property">
/// A property key whose values name groups (a single choice or a true/false flag), or <c>$type</c>. A row's stored string, true/false or numeric value names
/// its group; anything else (absent, empty, a list) is the "no value" group, keyed null.
/// </param>
/// <param name="Order">
/// Group keys in the order to show them - a select's option order, which a cross-container query
/// cannot know. Keys not named follow, by text, with "no value" last. At most 100 keys of
/// at most 128 characters.
/// </param>
internal sealed record QueryGroupByContract(string? Property, IReadOnlyList<string>? Order);

/// <summary>An ad-hoc query over one workspace: the saved query view's rule shape, without a saved view.</summary>
/// <param name="Scope">Where to look; the whole workspace when absent.</param>
/// <param name="Preset">
/// A starting rule set, ANDed with <paramref name="Filters"/>: <c>today</c>,
/// <c>next-seven-days</c>, <c>overdue</c> or <c>assigned-to-me</c> - the shipped smart lists.
/// </param>
/// <param name="Filters">The rules, in the grammar the query view stores. At most eight with the preset's, groups included.</param>
/// <param name="Sort">The order; when absent, the first date rule's property soonest first, else most recently modified first.</param>
/// <param name="GroupBy">Group the rows; every row of a group arrives before the next group, and groups come before the limit.</param>
/// <param name="Limit">The most rows to return: 100 when absent, never more than 500.</param>
/// <param name="Today">
/// The caller's own day, <c>yyyy-MM-dd</c>. Required when any rule uses a day token or a window;
/// never guessed from the server's clock.
/// </param>
internal sealed record WorkspaceQueryRequest(
    QueryScopeContract? Scope,
    string? Preset,
    IReadOnlyList<FilterRuleContract>? Filters,
    QuerySortContract? Sort,
    QueryGroupByContract? GroupBy,
    int? Limit,
    string? Today);

/// <summary>A fold over a query's matches.</summary>
/// <param name="Function"><c>count</c>, <c>sum</c>, <c>avg</c>, <c>min</c> or <c>max</c>.</param>
/// <param name="Property">The numeric property to fold; required for every function but <c>count</c>, which takes none.</param>
internal sealed record QueryAggregateContract(string? Function, string? Property);

/// <summary>An ad-hoc aggregate over one workspace: the same match as a query, folded.</summary>
/// <param name="Scope">Where to look; the whole workspace when absent.</param>
/// <param name="Preset">A starting rule set, as for a query.</param>
/// <param name="Filters">The rules, as for a query.</param>
/// <param name="GroupBy">Fold per group; at most 100 groups are returned, and the totals cover every row.</param>
/// <param name="Aggregate">The fold.</param>
/// <param name="Today">The caller's own day, as for a query.</param>
internal sealed record WorkspaceAggregateRequest(
    QueryScopeContract? Scope,
    string? Preset,
    IReadOnlyList<FilterRuleContract>? Filters,
    QueryGroupByContract? GroupBy,
    QueryAggregateContract? Aggregate,
    string? Today);

/// <summary>One item an ad-hoc query matched.</summary>
/// <param name="Id">The item.</param>
/// <param name="WorkspaceId">The workspace it lives in.</param>
/// <param name="ContainerId">Its parent, or null at a workspace root.</param>
/// <param name="ContainerTitle">The parent's title, or null, so a row can say where it lives.</param>
/// <param name="Title">The item's title, or null when it has never been named.</param>
/// <param name="Type">The item's body kind.</param>
/// <param name="Properties">The property bag as stored.</param>
/// <param name="Group">The row's group key when the query was grouped; null for "no value" or when ungrouped.</param>
internal sealed record WorkspaceQueryRowResponse(
    Guid Id,
    Guid WorkspaceId,
    Guid? ContainerId,
    string? ContainerTitle,
    string? Title,
    string Type,
    JsonObject Properties,
    string? Group);

/// <summary>One group of a grouped query, in display order.</summary>
/// <param name="Key">The group's value, or null for "no value".</param>
/// <param name="Label">What to call it: today the key itself, null for "no value" - the server invents no copy.</param>
/// <param name="Count">Every matched row in the group, including any the limit cut.</param>
internal sealed record QueryGroupResponse(string? Key, string? Label, long Count);

/// <summary>What an ad-hoc query answered.</summary>
/// <param name="WorkspaceId">The workspace that was queried.</param>
/// <param name="Today">The day the tokens resolved to, echoed; null when none was sent.</param>
/// <param name="Results">The matches, grouped when asked, in a stable order.</param>
/// <param name="Limit">The ceiling the run applied.</param>
/// <param name="Truncated">Whether more rows matched than the limit allowed.</param>
/// <param name="GroupBy">The grouping that was applied, or null.</param>
/// <param name="Groups">The groups the returned rows fall in, in order; empty when ungrouped.</param>
internal sealed record WorkspaceQueryResponse(
    Guid WorkspaceId,
    string? Today,
    IReadOnlyList<WorkspaceQueryRowResponse> Results,
    int Limit,
    bool Truncated,
    string? GroupBy,
    IReadOnlyList<QueryGroupResponse> Groups);

/// <summary>One group of an aggregate.</summary>
/// <param name="Key">The group's value, or null for "no value".</param>
/// <param name="Label">What to call it: the key itself, null for "no value".</param>
/// <param name="Value">The fold over the group's numbers, or null when it has none; for <c>count</c>, the row count.</param>
/// <param name="Count">How many rows the group holds.</param>
/// <param name="Skipped">How many of them held a value that is not a number, left out of the fold.</param>
internal sealed record AggregateGroupResponse(string? Key, string? Label, decimal? Value, long Count, long Skipped);

/// <summary>What an ad-hoc aggregate answered.</summary>
/// <param name="WorkspaceId">The workspace that was queried.</param>
/// <param name="Today">The day the tokens resolved to, echoed; null when none was sent.</param>
/// <param name="Function">The fold.</param>
/// <param name="Property">The property folded, or null for a count.</param>
/// <param name="GroupBy">The grouping, or null.</param>
/// <param name="Groups">The groups in display order, at most 100; empty when ungrouped.</param>
/// <param name="Total">The fold over every matched row, whatever the group ceiling cut.</param>
/// <param name="Count">How many rows matched.</param>
/// <param name="Skipped">
/// How many matched rows held a value that is not a number and were left out of the fold -
/// reported rather than counted as zero.
/// </param>
/// <param name="GroupCount">How many groups exist.</param>
/// <param name="Truncated">Whether groups exist beyond the ones returned.</param>
internal sealed record WorkspaceAggregateResponse(
    Guid WorkspaceId,
    string? Today,
    string Function,
    string? Property,
    string? GroupBy,
    IReadOnlyList<AggregateGroupResponse> Groups,
    decimal? Total,
    long Count,
    long Skipped,
    long GroupCount,
    bool Truncated);
