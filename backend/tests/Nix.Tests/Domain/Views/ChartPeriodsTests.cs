using Nix.Domain.Views;

namespace Nix.Tests.Domain.Views;

/// <summary>
/// The period arithmetic every time axis shares: where a period starts, how many lie between two
/// dates, and a rolling window.
/// </summary>
/// <remarks>
/// The edges are the whole point. A week that starts on Sunday for one reader and Monday for another,
/// or a quarter that slips at a year boundary, puts the same item in two different buckets in two
/// views of the same container.
/// </remarks>
public sealed class ChartPeriodsTests
{
    [Theory]
    [InlineData("2026-10-05", "2026-10-05")] // Monday is its own week's start.
    [InlineData("2026-10-11", "2026-10-05")] // Sunday belongs to the week that began the Monday before.
    [InlineData("2026-10-12", "2026-10-12")] // The next Monday starts the next week.
    [InlineData("2026-01-01", "2025-12-29")] // A Thursday New Year's Day: the week began in December.
    [InlineData("2024-03-03", "2024-02-26")] // Across a leap day.
    public void A_week_starts_on_the_Monday_on_or_before_the_date(string date, string expected)
    {
        Assert.Equal(
            DateOnly.Parse(expected, System.Globalization.CultureInfo.InvariantCulture),
            ChartPeriods.Start(Day(date), ChartPeriod.Week));
    }

    [Theory]
    [InlineData("2026-10-09", ChartPeriod.Day, "2026-10-09")]
    [InlineData("2026-10-09", ChartPeriod.Month, "2026-10-01")]
    [InlineData("2026-10-09", ChartPeriod.Quarter, "2026-10-01")]
    [InlineData("2026-09-30", ChartPeriod.Quarter, "2026-07-01")]
    [InlineData("2026-01-01", ChartPeriod.Quarter, "2026-01-01")]
    [InlineData("2026-03-31", ChartPeriod.Quarter, "2026-01-01")]
    [InlineData("2026-10-09", ChartPeriod.Year, "2026-01-01")]
    public void A_period_starts_on_its_first_day(string date, ChartPeriod period, string expected)
    {
        Assert.Equal(Day(expected), ChartPeriods.Start(Day(date), period));
    }

    [Theory]
    [InlineData("2026-02-01", ChartPeriod.Month, "2026-02-28")]
    [InlineData("2024-02-01", ChartPeriod.Month, "2024-02-29")]
    [InlineData("2026-10-05", ChartPeriod.Week, "2026-10-11")]
    [InlineData("2026-10-01", ChartPeriod.Quarter, "2026-12-31")]
    [InlineData("2026-01-01", ChartPeriod.Year, "2026-12-31")]
    public void A_period_ends_the_day_before_the_next_one_starts(string start, ChartPeriod period, string expected)
    {
        Assert.Equal(Day(expected), ChartPeriods.End(Day(start), period));
    }

    [Theory]
    [InlineData("2026-01-05", "2026-03-30", ChartPeriod.Week, 12)]
    [InlineData("2025-11-01", "2026-02-01", ChartPeriod.Month, 3)]
    [InlineData("2025-10-01", "2026-07-01", ChartPeriod.Quarter, 3)]
    [InlineData("2020-01-01", "2026-01-01", ChartPeriod.Year, 6)]
    [InlineData("2026-02-27", "2026-03-02", ChartPeriod.Day, 3)]
    public void Between_counts_whole_periods(string first, string last, ChartPeriod period, int expected)
    {
        Assert.Equal(expected, ChartPeriods.Between(Day(first), Day(last), period));
    }

    [Fact]
    public void The_last_twelve_months_end_with_the_current_one()
    {
        var range = ChartPeriods.Last(Day("2026-10-09"), ChartPeriod.Month, 12);

        Assert.Equal(Day("2025-11-01"), range.First);
        Assert.Equal(Day("2026-10-01"), range.Last);
        Assert.Equal(Day("2026-10-31"), range.End);
        Assert.Equal(12, range.Count);
    }

    [Fact]
    public void Enumerating_a_range_yields_every_period_in_order_including_empty_ones()
    {
        var range = ChartPeriods.Spanning(Day("2025-12-31"), Day("2026-01-13"), ChartPeriod.Week);

        Assert.Equal(
            [Day("2025-12-29"), Day("2026-01-05"), Day("2026-01-12")],
            ChartPeriods.Enumerate(range).ToArray());
    }

    [Fact]
    public void Keeping_the_latest_periods_cuts_the_earliest_end()
    {
        var range = new PeriodRange(Day("2020-01-01"), Day("2026-01-01"), ChartPeriod.Year);

        var kept = ChartPeriods.KeepLatest(range, 3);

        Assert.Equal(Day("2024-01-01"), kept.First);
        Assert.Equal(Day("2026-01-01"), kept.Last);
        Assert.Equal(range, ChartPeriods.KeepLatest(range, 10));
    }

    [Theory]
    [InlineData("2026-03-17", true)]
    [InlineData("2026-03-17T09:00:00+00:00[Europe/London]", true)]
    [InlineData("2026-13-01", false)]
    [InlineData("soon", false)]
    [InlineData("0001-01-01", false)]
    [InlineData(null, false)]
    public void A_stored_value_reads_as_its_date_part_or_not_at_all(string? text, bool expected)
    {
        Assert.Equal(expected, ChartPeriods.TryReadDate(text, out _));
    }

    [Fact]
    public void Every_period_round_trips_through_its_text()
    {
        foreach (var text in ChartPeriods.All)
        {
            Assert.True(ChartPeriods.TryParse(text, out var period));
            Assert.Equal(text, ChartPeriods.ToText(period));
        }

        Assert.False(ChartPeriods.TryParse("fortnight", out _));
    }

    private static DateOnly Day(string text) =>
        DateOnly.Parse(text, System.Globalization.CultureInfo.InvariantCulture);
}
