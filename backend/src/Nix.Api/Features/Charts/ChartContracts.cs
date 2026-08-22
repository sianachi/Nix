namespace Nix.Features.Charts;

/// <summary>One bar of a chart.</summary>
/// <param name="Value">
/// The grouping property's value, or <see langword="null"/> for the children that have none.
/// </param>
/// <param name="Children">How many children fall in this bucket.</param>
/// <param name="Total">
/// The measured property's total across them, or <see langword="null"/> when the chart counts
/// rather than totals, or when none of the children in this bucket carried a number.
/// </param>
/// <remarks>
/// <b>Unset is a bucket, not an omission.</b> A container half of whose children have no status is
/// mostly a container of unset things, and a chart that dropped them would draw the other half as
/// though it were the whole - misreporting every proportion on it.
/// </remarks>
internal sealed record ChartBucketResponse(string? Value, long Children, decimal? Total);

/// <summary>
/// A chart's data, and what it could not fit.
/// </summary>
/// <param name="ItemId">The container whose children were summarised.</param>
/// <param name="ViewId">The view whose configuration produced this.</param>
/// <param name="GroupBy">The property the buckets are values of.</param>
/// <param name="Measure">What each bar measures: <c>count</c> or <c>sum</c>.</param>
/// <param name="MeasureProperty">The property being totalled, when the measure is a total.</param>
/// <param name="Buckets">The buckets that fit, largest first.</param>
/// <param name="Children">
/// How many children were summarised in total, across every bucket including any left out.
/// </param>
/// <param name="DistinctValues">
/// How many distinct values the grouping property takes across those children, whether or not each
/// one fitted.
/// </param>
/// <param name="Truncated">
/// Whether more buckets exist than were returned. Carried rather than left for a client to infer
/// from a count, because inferring it is exactly the sort of arithmetic a client gets wrong once
/// and then draws confidently forever.
/// </param>
/// <remarks>
/// <para>
/// <b>The totals are what make a bounded chart honest.</b> A grouping property that is not a
/// declared list can take a distinct value per child, so the read is bounded - and a bounded read
/// that returned only its buckets would be a picture of the top few presented as a picture of all
/// of them. With <see cref="Children"/> and <see cref="DistinctValues"/>, the view can say how much
/// is missing instead of drawing the rest as though it were everything.
/// </para>
/// <para>
/// <b>Computed over every child, not over the page the client happens to hold.</b> That is the
/// whole reason this is a server read rather than a tally in the browser; ADR-0044 records it.
/// </para>
/// </remarks>
internal sealed record ChartResponse(
    Guid ItemId,
    string ViewId,
    string GroupBy,
    string Measure,
    string? MeasureProperty,
    IReadOnlyList<ChartBucketResponse> Buckets,
    long Children,
    long DistinctValues,
    bool Truncated);
