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

/// <summary>The grid, and the account it was narrowed to when it was; every total is that account's alone.</summary>
public sealed record BudgetGrid(IReadOnlyList<YearMonth> Months, IReadOnlyList<BudgetSectionRow> Sections, IReadOnlyList<BudgetMonthTotals> Totals, Guid? AccountId);

/// <summary>Lines down the side, months across: the plan, the actual and the variance in one table.</summary>
public static class BudgetGrids
{
    public const int MaximumMonths = 36;

    /// <summary>
    /// The grid over every line, or over one account's lines when <paramref name="accountId"/> is
    /// given. Narrowed, the section totals, the month totals and the unassigned row all count only
    /// what moved on that account, so the foot of the table reads as the account's own month.
    /// </summary>
    public static BudgetGrid Compute(FinanceBook book, YearMonth from, YearMonth to, Guid? accountId = null)
    {
        ArgumentNullException.ThrowIfNull(book);
        if (to < from || to.Index - from.Index >= MaximumMonths)
        {
            throw new ArgumentOutOfRangeException(nameof(to), to, $"Choose an ordered range of at most {MaximumMonths} months.");
        }
        var months = YearMonth.Range(from, to).ToList();
        var sections = new List<BudgetSectionRow>();
        var lines = accountId is { } only ? book.LinesOn(only) : book.Lines;
        foreach (var group in lines.GroupBy(line => (line.Section, line.Flow)))
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
            cumulativePlan += book.Figures(month, FigureSource.Plan, accountId).Net;
            cumulativeActual += book.Figures(month, FigureSource.Actual, accountId).Net;
        }
        var totalsByMonth = new List<BudgetMonthTotals>();
        foreach (var month in months)
        {
            var plan = book.Figures(month, FigureSource.Plan, accountId);
            var actual = book.Figures(month, FigureSource.Actual, accountId);
            cumulativePlan += plan.Net;
            cumulativeActual += actual.Net;
            totalsByMonth.Add(new BudgetMonthTotals(
                month,
                book.IsClosed(month),
                plan,
                actual,
                accountId is { } chosen ? book.UnassignedOutflow(chosen, month) : book.UnassignedOutflow(month),
                accountId is { } inflowAccount ? book.UnassignedInflow(inflowAccount, month) : book.UnassignedInflow(month),
                accountId is { } countAccount ? book.UnassignedCount(countAccount, month) : book.UnassignedCount(month),
                cumulativePlan,
                cumulativeActual));
        }
        return new BudgetGrid(months, sections, totalsByMonth, accountId);
    }
}
