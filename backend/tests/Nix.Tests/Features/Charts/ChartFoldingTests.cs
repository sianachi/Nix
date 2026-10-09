using System.Globalization;
using Nix.Abstractions;
using Nix.Domain.Views;
using Nix.Features.Charts;

namespace Nix.Tests.Features.Charts;

/// <summary>
/// What a chart may claim from the cells its reads return: empty periods as zeros, series capped
/// with the rest reported, and nothing drawn short because a ceiling cut it.
/// </summary>
public sealed class ChartFoldingTests
{
    [Fact]
    public void A_time_axis_fills_every_empty_period_with_zero_in_chronological_order()
    {
        ChildCells read = new(
            [
                new ChildCell("2026-03-14", null, 2, null),
                new ChildCell("2026-01-02", null, 1, null),
                new ChildCell("2026-01-30", null, 3, null),
            ],
            Children: 6,
            DistinctBuckets: null,
            CellsCut: false);

        var chart = ChartFolding.Days(read, ChartPeriod.Month, null, null, split: false);

        Assert.Equal(["2026-01-01", "2026-02-01", "2026-03-01"], chart.Buckets.Select(bucket => bucket.Value));
        Assert.Equal([4L, 0L, 2L], chart.Buckets.Select(bucket => bucket.Children));
        Assert.Equal(6, chart.Children);
        Assert.Equal(3, chart.DistinctValues);
        Assert.False(chart.Truncated);
        Assert.Equal(new DateOnly(2026, 1, 1), chart.From);
        Assert.Equal(new DateOnly(2026, 3, 31), chart.To);
    }

    [Fact]
    public void Days_either_side_of_a_week_boundary_fall_in_different_weeks()
    {
        // Sunday the 11th closes the week of Monday the 5th; Monday the 12th opens the next.
        ChildCells read = new(
            [
                new ChildCell("2026-10-12", null, 1, null),
                new ChildCell("2026-10-11", null, 2, null),
                new ChildCell("2026-10-05", null, 4, null),
            ],
            7,
            null,
            false);

        var chart = ChartFolding.Days(read, ChartPeriod.Week, null, null, split: false);

        Assert.Equal(["2026-10-05", "2026-10-12"], chart.Buckets.Select(bucket => bucket.Value));
        Assert.Equal([6L, 1L], chart.Buckets.Select(bucket => bucket.Children));
    }

    [Fact]
    public void A_window_draws_its_whole_span_even_where_nothing_was_recorded()
    {
        ChildCells read = new([new ChildCell("2026-05-20", null, 1, 4m)], 1, null, false);

        var chart = ChartFolding.Days(
            read,
            ChartPeriod.Month,
            new DateOnly(2026, 4, 15),
            new DateOnly(2026, 7, 1),
            split: false);

        Assert.Equal(
            ["2026-04-01", "2026-05-01", "2026-06-01", "2026-07-01"],
            chart.Buckets.Select(bucket => bucket.Value));
        Assert.Equal([null, 4m, null, null], chart.Buckets.Select(bucket => bucket.Total));
        Assert.Equal(new DateOnly(2026, 7, 31), chart.To);
    }

    [Fact]
    public void Undated_children_are_reported_as_unplaced_rather_than_dropped()
    {
        ChildCells read = new(
            [
                new ChildCell(null, null, 5, null),
                new ChildCell("not a date", null, 1, null),
                new ChildCell("2026-01-01", null, 2, null),
            ],
            8,
            null,
            false);

        var chart = ChartFolding.Days(read, ChartPeriod.Year, null, null, split: false);

        Assert.Equal(6, chart.Unplaced);
        Assert.Equal(2, chart.Children);
        Assert.Equal(2, Assert.Single(chart.Buckets).Children);
    }

    [Fact]
    public void A_read_the_ceiling_cut_drops_its_earliest_period_rather_than_drawing_it_short()
    {
        // Latest first: the oldest day read may be missing cells the ceiling stopped before.
        ChildCells read = new(
            [
                new ChildCell("2026-03-02", null, 1, null),
                new ChildCell("2026-02-10", null, 1, null),
                new ChildCell("2026-01-31", null, 1, null),
            ],
            9,
            null,
            CellsCut: true);

        var chart = ChartFolding.Days(read, ChartPeriod.Month, new DateOnly(2025, 1, 1), null, split: false);

        Assert.True(chart.Truncated);
        Assert.Equal(["2026-02-01", "2026-03-01"], chart.Buckets.Select(bucket => bucket.Value));
    }

    [Fact]
    public void A_daily_axis_longer_than_a_year_grid_keeps_its_most_recent_periods()
    {
        ChildCells read = new(
            [
                new ChildCell("2026-12-31", null, 1, null),
                new ChildCell("2020-01-01", null, 1, null),
            ],
            2,
            null,
            false);

        var chart = ChartFolding.Days(read, ChartPeriod.Day, null, null, split: false);

        Assert.True(chart.Truncated);
        Assert.Equal(ChartOptions.MaximumPeriods, chart.Buckets.Count);
        Assert.Equal("2026-12-31", chart.Buckets[^1].Value);
        Assert.True(chart.DistinctValues > ChartOptions.MaximumPeriods);
    }

    [Fact]
    public void Series_past_the_twelfth_are_folded_into_one_reported_Other()
    {
        var cells = new List<ChildCell>();
        for (var index = 0; index < 15; index++)
        {
            // Series s00 is the largest, s14 the smallest, so the cap keeps s00 to s11.
            cells.Add(new ChildCell("2026-01-05", $"s{index:00}", 20 - index, index));
        }

        ChildCells read = new(cells, cells.Sum(cell => cell.Children), null, false);

        var chart = ChartFolding.Days(read, ChartPeriod.Week, null, null, split: true);

        Assert.Equal(13, chart.Series.Count);
        Assert.Equal(
            Enumerable.Range(0, 12).Select(index => $"s{index:00}"),
            chart.Series.Take(12).Select(series => series.Value));
        var other = chart.Series[^1];
        Assert.True(other.Other);
        Assert.Null(other.Value);
        Assert.Equal(8 + 7 + 6, other.Children);
        Assert.Equal(12m + 13m + 14m, other.Total);
        Assert.Equal(3, chart.OtherSeries);

        var bucket = Assert.Single(chart.Buckets);
        Assert.Equal(13, bucket.Cells.Count);
        Assert.Equal(bucket.Children, bucket.Cells.Sum(cell => cell.Children));
    }

    [Fact]
    public void Twelve_series_fit_without_an_Other()
    {
        var cells = Enumerable.Range(0, 12)
            .Select(index => new ChildCell("2026-01-05", index.ToString(CultureInfo.InvariantCulture), 1, null))
            .ToList();

        var chart = ChartFolding.Days(new ChildCells(cells, 12, null, false), ChartPeriod.Week, null, null, split: true);

        Assert.Equal(12, chart.Series.Count);
        Assert.DoesNotContain(chart.Series, series => series.Other);
        Assert.Equal(0, chart.OtherSeries);
    }

    [Fact]
    public void Children_with_no_series_value_are_a_series_of_their_own()
    {
        ChildCells read = new(
            [
                new ChildCell("Open", null, 3, null),
                new ChildCell("Open", "true", 1, null),
                new ChildCell("Done", "true", 2, null),
            ],
            6,
            2,
            false);

        var chart = ChartFolding.CategoriesBySeries(read);

        Assert.Equal(2, chart.Series.Count);
        Assert.Contains(chart.Series, series => series.Value is null && !series.Other);
        Assert.Contains(chart.Series, series => series.Value == "true");
        var open = chart.Buckets[0];
        Assert.Equal("Open", open.Value);
        Assert.Equal(4, open.Children);
        Assert.Equal(4, open.Cells.Sum(cell => cell.Children));

        var done = chart.Buckets[1];
        Assert.Equal(0, done.Cells[chart.Series.ToList().FindIndex(series => series.Value is null)].Children);
    }

    [Fact]
    public void A_split_read_the_ceiling_cut_leaves_out_its_last_bucket_and_says_so()
    {
        ChildCells read = new(
            [
                new ChildCell("Open", "a", 3, null),
                new ChildCell("Open", "b", 2, null),
                new ChildCell("Done", "a", 1, null),
            ],
            9,
            3,
            CellsCut: true);

        var chart = ChartFolding.CategoriesBySeries(read);

        Assert.Equal(["Open"], chart.Buckets.Select(bucket => bucket.Value));
        Assert.True(chart.Truncated);
        Assert.Equal(3, chart.DistinctValues);
    }

    [Fact]
    public void A_chart_of_categories_keeps_the_shape_it_always_had()
    {
        var chart = ChartFolding.Categories(new ChildBuckets([new ChildBucket("Open", 2, null)], 3, 5));

        var bucket = Assert.Single(chart.Buckets);
        Assert.Empty(bucket.Cells);
        Assert.Empty(chart.Series);
        Assert.True(chart.Truncated);
        Assert.Equal(5, chart.Children);
    }
}
