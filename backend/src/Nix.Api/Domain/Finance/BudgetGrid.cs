namespace Nix.Domain.Finance;

/// <summary>One line in one month: what was planned, what happened, and how many transactions said so.</summary>
public sealed record BudgetCell(YearMonth Month, decimal Plan, decimal Actual, int Transactions)
{
    /// <summary>Actual minus plan: positive means over for spending, and more than planned for income.</summary>
    public decimal Variance => Actual - Plan;
}

public sealed record BudgetLineRow(BudgetLine Line, IReadOnlyList<BudgetCell> Cells);

public sealed record BudgetSectionRow(string Name, string Flow, IReadOnlyList<BudgetLineRow> Lines, IReadOnlyList<BudgetCell> Totals);

/// <summary>The month's totals from both sources side by side, with the running net since the start month.</summary>
public sealed record BudgetMonthTotals(
    YearMonth Month,
    bool Closed,
    MonthFigures Plan,
    MonthFigures Actual,
    decimal UnassignedOutflow,
    decimal UnassignedInflow,
    int UnassignedTransactions,
    decimal CumulativeNetPlan,
    decimal CumulativeNetActual);

public sealed record BudgetGrid(IReadOnlyList<YearMonth> Months, IReadOnlyList<BudgetSectionRow> Sections, IReadOnlyList<BudgetMonthTotals> Totals);

/// <summary>Lines down the side, months across: the plan, the actual and the variance in one table.</summary>
public static class BudgetGrids
{
    public const int MaximumMonths = 36;

    public static BudgetGrid Compute(FinanceBook book, YearMonth from, YearMonth to)
    {
        ArgumentNullException.ThrowIfNull(book);
        if (to < from || to.Index - from.Index >= MaximumMonths)
        {
            throw new ArgumentOutOfRangeException(nameof(to), to, $"Choose an ordered range of at most {MaximumMonths} months.");
        }
        var months = YearMonth.Range(from, to).ToList();
        var sections = new List<BudgetSectionRow>();
        foreach (var group in book.Lines.GroupBy(line => (line.Section, line.Flow)))
        {
            var rows = group.Select(line => new BudgetLineRow(
                line,
                months.Select(month => new BudgetCell(month, book.Plan(line, month), book.Actual(line, month), book.TransactionCount(line, month))).ToList())).ToList();
            var totals = months.Select((month, index) => new BudgetCell(
                month,
                rows.Sum(row => row.Cells[index].Plan),
                rows.Sum(row => row.Cells[index].Actual),
                rows.Sum(row => row.Cells[index].Transactions))).ToList();
            sections.Add(new BudgetSectionRow(group.Key.Section, group.Key.Flow, rows, totals));
        }

        // The running net counts from the plan's first month, not the window's, so a window opened
        // half way through still says where the year stands.
        decimal cumulativePlan = 0, cumulativeActual = 0;
        foreach (var month in YearMonth.Range(book.Settings.StartMonth < from ? book.Settings.StartMonth : from, from.AddMonths(-1)))
        {
            cumulativePlan += book.Figures(month, FigureSource.Plan).Net;
            cumulativeActual += book.Figures(month, FigureSource.Actual).Net;
        }
        var totalsByMonth = new List<BudgetMonthTotals>();
        foreach (var month in months)
        {
            var plan = book.Figures(month, FigureSource.Plan);
            var actual = book.Figures(month, FigureSource.Actual);
            cumulativePlan += plan.Net;
            cumulativeActual += actual.Net;
            totalsByMonth.Add(new BudgetMonthTotals(
                month,
                book.IsClosed(month),
                plan,
                actual,
                book.UnassignedOutflow(month),
                book.UnassignedInflow(month),
                book.UnassignedCount(month),
                cumulativePlan,
                cumulativeActual));
        }
        return new BudgetGrid(months, sections, totalsByMonth);
    }
}
