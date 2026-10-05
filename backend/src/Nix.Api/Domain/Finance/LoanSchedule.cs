namespace Nix.Domain.Finance;

/// <summary>One month of a loan: what was owed, the interest that accrued, what was paid, and what is owed now.</summary>
public sealed record LoanMonth(int Number, YearMonth Month, decimal Opening, decimal Interest, decimal Payment, decimal Principal, decimal Closing);

/// <summary>A repayment schedule to the last penny, and the totals it comes to.</summary>
/// <param name="Cleared">Whether the balance reaches zero inside the schedule's length.</param>
/// <param name="ClearedIn">The month of the final payment, when cleared.</param>
public sealed record LoanSchedule(
    decimal Opening,
    decimal Apr,
    decimal Payment,
    decimal Overpayment,
    IReadOnlyList<LoanMonth> Months,
    decimal TotalInterest,
    decimal TotalPaid,
    bool Cleared,
    YearMonth? ClearedIn)
{
    public int MonthsToClear => Months.Count;
}

/// <summary>What a different overpayment buys: months and interest against the baseline.</summary>
public sealed record LoanComparison(LoanSchedule Baseline, LoanSchedule Alternative)
{
    public int MonthsSaved => Baseline.MonthsToClear - Alternative.MonthsToClear;
    public decimal InterestSaved => Baseline.TotalInterest - Alternative.TotalInterest;
}

/// <summary>A true amortisation, rounding the way a lender does.</summary>
/// <remarks>
/// Interest is the opening balance at a twelfth of the annual rate, rounded to the penny; the
/// payment is the standard payment plus overpayment, or whatever clears the balance if that is
/// less; the principal is what remains of the payment after interest. A rate that never clears
/// the balance stops at <see cref="MaximumMonths"/> and says so, instead of running forever.
/// </remarks>
public static class LoanSchedules
{
    public const int MaximumMonths = 600;

    public static LoanSchedule Compute(decimal opening, decimal apr, decimal payment, decimal overpayment, YearMonth start)
    {
        var months = new List<LoanMonth>();
        var balance = MoneyRules.Round(opening);
        decimal interestTotal = 0, paidTotal = 0;
        var month = start;
        for (var number = 1; balance > 0.005m && number <= MaximumMonths; number++)
        {
            var interest = MoneyRules.Round(balance * apr / 12);
            var due = Math.Min(payment + overpayment, balance + interest);
            var paid = MoneyRules.Round(due);
            var principal = paid - interest;
            var closing = MoneyRules.Round(balance - principal);
            months.Add(new LoanMonth(number, month, balance, interest, paid, principal, closing));
            interestTotal += interest;
            paidTotal += paid;
            balance = closing;
            month = month.AddMonths(1);
        }
        var cleared = balance <= 0.005m;
        return new LoanSchedule(opening, apr, payment, overpayment, months, interestTotal, paidTotal, cleared, cleared && months.Count > 0 ? months[^1].Month : null);
    }

    public static LoanSchedule Compute(FinanceAccount loan, YearMonth start, decimal? overpayment = null)
    {
        ArgumentNullException.ThrowIfNull(loan);
        if (!loan.IsLoan)
        {
            throw new ArgumentException("Only a loan has a repayment schedule.", nameof(loan));
        }
        return Compute(loan.OpeningBalance, loan.Apr ?? 0, loan.Payment ?? 0, overpayment ?? loan.Overpayment ?? 0, start);
    }

    /// <summary>The balance still owed at the end of a month, following the schedule as configured.</summary>
    public static decimal BalanceAfter(LoanSchedule schedule, YearMonth month)
    {
        ArgumentNullException.ThrowIfNull(schedule);
        var row = schedule.Months.LastOrDefault(row => row.Month <= month);
        return row is null ? schedule.Opening : row.Closing;
    }
}
