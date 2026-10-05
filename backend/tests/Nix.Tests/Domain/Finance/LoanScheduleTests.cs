using Nix.Domain.Finance;

namespace Nix.Tests.Domain.Finance;

/// <summary>Amortisation of a synthetic loan, including rounded interest and early repayment.</summary>
public sealed class LoanScheduleTests
{
    private static readonly YearMonth Start = new(2026, 8);

    [Fact]
    public void The_synthetic_baseline_clears_with_rounded_interest()
    {
        var schedule = LoanSchedules.Compute(6000m, 0.06m, 300m, 0m, Start);

        Assert.True(schedule.Cleared);
        Assert.Equal(22, schedule.MonthsToClear);
        Assert.Equal(new YearMonth(2028, 5), schedule.ClearedIn);
        Assert.Equal(337.50m, schedule.TotalInterest);
        Assert.Equal(0m, schedule.Months[^1].Closing);
        Assert.True(schedule.Months[^1].Payment < 300m, "the final payment is whatever clears the balance");
    }

    [Theory]
    [InlineData(50, 18, 48)]
    [InlineData(100, 16, 84)]
    [InlineData(200, 13, 134)]
    public void An_overpayment_reduces_the_synthetic_term_and_interest(int overpayment, int months, int saved)
    {
        var baseline = LoanSchedules.Compute(6000m, 0.06m, 300m, 0m, Start);
        var alternative = LoanSchedules.Compute(6000m, 0.06m, 300m, overpayment, Start);
        var comparison = new LoanComparison(baseline, alternative);

        Assert.Equal(months, alternative.MonthsToClear);
        Assert.Equal(22 - months, comparison.MonthsSaved);
        Assert.InRange(comparison.InterestSaved, saved - 3, saved + 3);
    }

    [Fact]
    public void Every_month_balances_to_the_penny()
    {
        var schedule = LoanSchedules.Compute(6000m, 0.06m, 300m, 0m, Start);

        var previous = schedule.Opening;
        foreach (var month in schedule.Months)
        {
            Assert.Equal(previous, month.Opening);
            Assert.Equal(month.Payment - month.Interest, month.Principal);
            Assert.Equal(month.Opening - month.Principal, month.Closing);
            previous = month.Closing;
        }
        Assert.Equal(schedule.Months.Sum(month => month.Interest), schedule.TotalInterest);
        Assert.Equal(schedule.Months.Sum(month => month.Payment), schedule.TotalPaid);
    }

    [Fact]
    public void A_payment_that_never_covers_the_interest_stops_at_the_ceiling_and_says_so()
    {
        var schedule = LoanSchedules.Compute(100_000m, 0.5m, 10m, 0m, Start);

        Assert.False(schedule.Cleared);
        Assert.Null(schedule.ClearedIn);
        Assert.Equal(LoanSchedules.MaximumMonths, schedule.MonthsToClear);
    }

    [Fact]
    public void The_balance_after_a_month_follows_the_schedule()
    {
        var schedule = LoanSchedules.Compute(6000m, 0.06m, 300m, 0m, Start);

        Assert.Equal(6000m, LoanSchedules.BalanceAfter(schedule, new YearMonth(2026, 7)));
        Assert.Equal(schedule.Months[0].Closing, LoanSchedules.BalanceAfter(schedule, Start));
        Assert.Equal(0m, LoanSchedules.BalanceAfter(schedule, new YearMonth(2031, 1)));
    }
}
