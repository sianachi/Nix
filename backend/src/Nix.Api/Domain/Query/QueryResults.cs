using Nix.Domain.Items;
using Nix.Domain.Tenancy;

namespace Nix.Domain.Query;

/// <summary>
/// One item a saved query matched, with enough of its surroundings to say where it lives.
/// </summary>
/// <param name="Id">The item.</param>
/// <param name="WorkspaceId">The workspace it lives in.</param>
/// <param name="ContainerId">Its parent, or <see langword="null"/> at a workspace root.</param>
/// <param name="ContainerTitle">
/// The parent's title, or <see langword="null"/>. Carried because a cross-container result list
/// is unreadable without saying which container each row came from - the calendar's own lesson.
/// </param>
/// <param name="Title">The item's title, or <see langword="null"/> when it has none.</param>
/// <param name="Type">The item's body kind.</param>
/// <param name="PropertiesJson">The property bag exactly as stored, for the contract to parse.</param>
public sealed record QueryResultItem(
    ItemId Id,
    WorkspaceId WorkspaceId,
    ItemId? ContainerId,
    string? ContainerTitle,
    string? Title,
    string Type,
    string? PropertiesJson)
{
    /// <summary>The group this row belongs to when the query was grouped; null otherwise or for "no value".</summary>
    public string? Group { get; init; }
}

/// <summary>
/// What a saved query answered: the rows, and whether the ceiling cut them.
/// </summary>
/// <param name="Items">The matches, in the statement's stable order.</param>
/// <param name="Truncated">
/// Whether more rows matched than the ceiling allowed. The honest-state field: a list that was
/// cut and does not say so reads as a list that ended.
/// </param>
public sealed record QueryResults(IReadOnlyList<QueryResultItem> Items, bool Truncated)
{
    /// <summary>
    /// The groups the returned rows fall in, in the order they appear, or empty when the query was
    /// not grouped. Rows arrive grouped - every row of one group before the next - so a list cut
    /// by the limit has whole groups first.
    /// </summary>
    public IReadOnlyList<QueryGroup> Groups { get; init; } = [];

    /// <summary>A query that matched nothing.</summary>
    public static readonly QueryResults Empty = new([], false);
}

/// <summary>One group of a grouped query, as its returned rows met it.</summary>
/// <param name="Key">The group's value, or <see langword="null"/> for the "no value" group.</param>
/// <param name="Count">
/// Every matched row in the group, not only the returned ones - so the last group of a truncated
/// list can say how much of it was cut.
/// </param>
public sealed record QueryGroup(string? Key, long Count);

/// <summary>A fold over a query's matches.</summary>
/// <param name="Function">One of <see cref="QueryAggregateFunctions"/>.</param>
/// <param name="Property">The numeric property folded, or <see langword="null"/> for a count.</param>
public sealed record QueryAggregate(string Function, string? Property);

/// <summary>The folds an aggregate may ask for.</summary>
public static class QueryAggregateFunctions
{
    /// <summary>How many rows matched. Takes no property.</summary>
    public const string Count = "count";

    /// <summary>The total of a numeric property.</summary>
    public const string Sum = "sum";

    /// <summary>The mean of a numeric property, rounded to six places.</summary>
    public const string Average = "avg";

    /// <summary>The least value of a numeric property.</summary>
    public const string Minimum = "min";

    /// <summary>The greatest value of a numeric property.</summary>
    public const string Maximum = "max";

    /// <summary>Every fold, in the order the contract lists them.</summary>
    public static readonly System.Collections.Immutable.ImmutableArray<string> All =
        [Count, Sum, Average, Minimum, Maximum];
}

/// <summary>One group of an aggregate.</summary>
/// <param name="Key">The group's value, or <see langword="null"/> for the "no value" group.</param>
/// <param name="Value">
/// The fold over the group's readable numbers, or <see langword="null"/> when it has none to fold.
/// For a count, the number of rows.
/// </param>
/// <param name="Count">How many rows the group holds.</param>
/// <param name="Skipped">How many of them held a value that could not be read as a number.</param>
public sealed record QueryAggregateGroup(string? Key, decimal? Value, long Count, long Skipped);

/// <summary>What an aggregate answered.</summary>
/// <param name="Groups">The groups, in order, at most the requested ceiling; empty when ungrouped.</param>
/// <param name="Total">The fold over every matched row, whatever the group ceiling cut.</param>
/// <param name="Count">How many rows matched.</param>
/// <param name="Skipped">
/// How many matched rows held a value that is not a number (text that does not read as one, a
/// list, a number too large to total). Reported rather than counted as zero: a total that quietly
/// treated "about 40" as nothing would be wrong without saying so.
/// </param>
/// <param name="GroupCount">How many groups exist, including any the ceiling cut.</param>
public sealed record QueryAggregateResults(
    IReadOnlyList<QueryAggregateGroup> Groups,
    decimal? Total,
    long Count,
    long Skipped,
    long GroupCount)
{
    /// <summary>Whether the ceiling left groups out.</summary>
    public bool Truncated => GroupCount > Groups.Count;

    /// <summary>An aggregate over nothing.</summary>
    public static readonly QueryAggregateResults Empty = new([], null, 0, 0, 0);
}
