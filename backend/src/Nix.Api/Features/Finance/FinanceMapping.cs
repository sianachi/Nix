using Nix.Domain.Finance;

namespace Nix.Features.Finance;

/// <summary>Domain records to wire records, and back for the requests that carry a whole record.</summary>
internal static class FinanceMapping
{
    public static FinanceSettingsResponse ToResponse(this FinanceSettings settings) =>
        new(settings.Currency, settings.StartMonth.ToString(), settings.EndMonth.ToString(), settings.HorizonMonths, settings.OpeningCash, settings.EmergencyFundMonths, settings.Timezone);

    public static FinanceContainersResponse ToResponse(this FinanceContainers containers) =>
        new(containers.Accounts, containers.Lines, containers.Transactions);

    public static FinanceAccountResponse ToResponse(this FinanceAccount account) =>
        new(account.Id, account.Name, account.Type, account.Limit, account.OpeningBalance, account.SettlesFrom, account.Apr, account.Payment, account.Overpayment, account.Target, account.Archived);

    public static FinanceAccount ToAccount(this FinanceAccountRequest request, Guid id) =>
        new(id, request.Name?.Trim() ?? string.Empty, request.Type ?? string.Empty, request.Limit, request.OpeningBalance, request.SettlesFrom, request.Apr, request.Payment, request.Overpayment, request.Target, request.Archived);

    public static BudgetLineResponse ToResponse(this BudgetLine line) =>
        new(line.Id, line.Name, line.Section, line.Flow, line.AccountId, line.Amount, line.Overrides.ToDictionary(pair => pair.Key.ToString(), pair => pair.Value), line.Scheduled, line.DueDay, line.LoanAccount, line.Archived, line.Position);

    /// <summary>The line a request describes, or the override month that could not be read.</summary>
    public static (BudgetLine? Line, string? Problem) ToLine(this BudgetLineRequest request, Guid id, long position)
    {
        var overrides = new Dictionary<YearMonth, decimal>();
        foreach (var (month, amount) in request.Overrides ?? new Dictionary<string, decimal>())
        {
            if (!YearMonth.TryParse(month, out var parsed))
            {
                return (null, $"'{month}' is not a month; overrides are keyed by yyyy-MM.");
            }
            overrides[parsed] = amount;
        }
        return (new BudgetLine(id, request.Name?.Trim() ?? string.Empty, request.Section?.Trim() ?? string.Empty, request.Flow ?? string.Empty, request.AccountId, request.Amount, overrides, request.Scheduled, request.DueDay, request.LoanAccount, request.Archived, position), null);
    }

    public static FinanceTransactionResponse ToResponse(this FinanceTransaction transaction) =>
        new(transaction.Id, transaction.Description, transaction.Date, transaction.Amount, transaction.AccountId, transaction.LineId, transaction.Source, transaction.PostedFor?.ToString(), transaction.ImportKey, transaction.Cleared);

    public static MonthFiguresResponse ToResponse(this MonthFigures figures) =>
        new(figures.Income, figures.PaidThisMonth, figures.CardSpend, figures.Outgoings, figures.Net);

    public static BudgetCellResponse ToResponse(this BudgetCell cell) =>
        new(cell.Month.ToString(), cell.Plan, cell.Actual, cell.Variance, cell.Transactions);

    public static BudgetGridResponse ToResponse(this BudgetGrid grid, Guid itemId) =>
        new(
            itemId,
            grid.Months.Select(month => month.ToString()).ToList(),
            grid.Sections.Select(section => new BudgetSectionResponse(
                section.Name,
                section.Flow,
                section.Lines.Select(row => new BudgetLineRowResponse(row.Line.ToResponse(), row.Cells.Select(ToResponse).ToList())).ToList(),
                section.Totals.Select(ToResponse).ToList())).ToList(),
            grid.Totals.Select(totals => new BudgetMonthTotalsResponse(
                totals.Month.ToString(),
                totals.Closed,
                totals.Plan.ToResponse(),
                totals.Actual.ToResponse(),
                totals.UnassignedOutflow,
                totals.UnassignedInflow,
                totals.UnassignedTransactions,
                totals.CumulativeNetPlan,
                totals.CumulativeNetActual)).ToList(),
            grid.AccountId);

    public static CardMonthResponse ToResponse(this CardMonth month, FinanceAccount card) =>
        new(card.Id, card.Name, month.Month.ToString(), SourceText(month.Source), month.Opening, month.Spend, month.PaymentOut, month.Closing, month.Utilisation, card.Limit, card.SettlesFrom);

    public static LoanSummaryResponse ToSummary(this LoanSchedule schedule, YearMonth asAt) =>
        new(schedule.Opening, schedule.Apr, schedule.Payment, schedule.Overpayment, schedule.MonthsToClear, schedule.TotalInterest, schedule.TotalPaid, schedule.Cleared, schedule.ClearedIn?.ToString(), LoanSchedules.BalanceAfter(schedule, asAt));

    public static LoanMonthResponse ToResponse(this LoanMonth month) =>
        new(month.Number, month.Month.ToString(), month.Opening, month.Interest, month.Payment, month.Principal, month.Closing);

    public static CashFlowMonthResponse ToResponse(this CashFlowMonth month) =>
        new(month.Month.ToString(), SourceText(month.Source), month.Income, month.PaidThisMonth, month.CardSpend, month.CardPaymentOut, month.CashNet, month.ClosingBank, month.CardOwed, month.NetPosition, month.EmergencyTarget, month.BufferMet);

    public static CashFlowResponse ToResponse(this CashFlowProjection projection, Guid itemId) =>
        new(itemId, projection.OpeningBank, projection.OpeningCardOwed, projection.OpeningNetPosition, projection.EmergencyTarget, projection.EmergencyBasisMonth.ToString(), projection.BufferMetIn?.ToString(), projection.Months.Select(ToResponse).ToList());

    public static string SourceText(FigureSource source) => source == FigureSource.Actual ? "actual" : "plan";
}
