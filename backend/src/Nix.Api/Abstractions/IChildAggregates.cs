using Nix.Domain.Items;
using Nix.Domain.Properties;
using Nix.Domain.Tenancy;

namespace Nix.Abstractions;

/// <summary>Which parent, and which of its children's properties.</summary>
/// <param name="Parent">The item whose children were folded.</param>
/// <param name="Key">The property key that was folded.</param>
public readonly record struct ChildAggregateKey(ItemId Parent, string Key);

/// <summary>One bucket of a chart: a value the children were grouped by, and what it holds.</summary>
/// <param name="Value">
/// The grouping property's value as text, or <see langword="null"/> for the children that have
/// none. Unset is a real bucket and often a large one; a chart that hid it would misreport every
/// proportion drawn beside it.
/// </param>
/// <param name="Children">How many children fell in this bucket.</param>
/// <param name="Total">
/// The sum of the measured property across them, or <see langword="null"/> when no measure was
/// asked for or none of them carried a number.
/// </param>
public sealed record ChildBucket(string? Value, long Children, decimal? Total);

/// <summary>
/// A chart's data: the buckets that fit, and enough to say honestly what did not.
/// </summary>
/// <param name="Buckets">The buckets, largest first.</param>
/// <param name="DistinctValues">
/// How many distinct values the grouping property takes across all the children, whether or not
/// they fit.
/// </param>
/// <param name="Children">
/// How many children were grouped in total, across every bucket including the ones left out.
/// </param>
/// <remarks>
/// <b>The two totals are what make a truncated chart honest.</b> A grouping property that is not a
/// declared list can produce a bucket per child, so the read is bounded - and a bounded read that
/// only returned its buckets would be a picture of the top few presented as a picture of all of
/// them. With these, the view can say how many are missing and how many children they account for.
/// </remarks>
public sealed record ChildBuckets(
    IReadOnlyList<ChildBucket> Buckets,
    long DistinctValues,
    long Children);

/// <summary>
/// Folds an item's children: what a rollup property reduces, and what a chart groups.
/// </summary>
/// <remarks>
/// <para>
/// <b>A port because it is I/O, and the only kind of interface this codebase adds.</b> One real
/// implementation over Postgres and a test fake for the use-case tests, which is the second of the
/// three justifications the standards allow.
/// </para>
/// <para>
/// <b>Batched by construction, like <c>IItemTree.WithChildrenAsync</c> and for the same reason.</b>
/// A page of fifty items each showing three rollups must be one query, not a hundred and fifty. A
/// single item is a page of one, so there is one code path rather than a bulk one and a scalar one
/// that can disagree.
/// </para>
/// <para>
/// <b>No permission check, deliberately.</b> A caller reaches this holding items a read check
/// already returned, and what it learns is an aggregate over rows row-level security scopes to the
/// tenant anyway. Asking again here would re-answer a settled question and invite the two answers
/// to drift - the argument <c>ItemsWithChildren</c> already makes.
/// </para>
/// </remarks>
public interface IChildAggregates
{
    /// <summary>
    /// Folds each named property across the children of each given parent.
    /// </summary>
    /// <param name="workspaceId">The workspace the parents live in.</param>
    /// <param name="parents">The items whose children are folded.</param>
    /// <param name="keys">The property keys to fold.</param>
    /// <param name="cancellationToken">Cancels the read.</param>
    /// <returns>
    /// One entry per parent and key that produced rows. A parent with no children is absent rather
    /// than present and empty, so the result is the size of the answer rather than of the question;
    /// the caller reduces a missing entry with <see cref="ChildAggregate.Empty"/>, which is not the
    /// same as having no answer - an empty container's count is zero and its "all" is true.
    /// </returns>
    public ValueTask<IReadOnlyDictionary<ChildAggregateKey, ChildAggregate>> FoldAsync(
        WorkspaceId workspaceId,
        IReadOnlyList<ItemId> parents,
        IReadOnlyList<string> keys,
        CancellationToken cancellationToken);

    /// <summary>
    /// Buckets one item's children by a property's value, counting them and summing a measure.
    /// </summary>
    /// <param name="workspaceId">The workspace the item lives in.</param>
    /// <param name="parent">The item whose children are grouped.</param>
    /// <param name="groupKey">The property whose values become buckets.</param>
    /// <param name="measureKey">
    /// The numeric property to total per bucket, or <see langword="null"/> to count only.
    /// </param>
    /// <param name="limit">The most buckets to return.</param>
    /// <param name="cancellationToken">Cancels the read.</param>
    /// <returns>The buckets that fit, and the totals that say what did not.</returns>
    public ValueTask<ChildBuckets> BucketAsync(
        WorkspaceId workspaceId,
        ItemId parent,
        string groupKey,
        string? measureKey,
        int limit,
        CancellationToken cancellationToken);
}
