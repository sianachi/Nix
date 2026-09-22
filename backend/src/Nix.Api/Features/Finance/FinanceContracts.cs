namespace Nix.Features.Finance;

// Months travel as yyyy-MM text and amounts as decimals with at most two places; the module
// validates both on the way in and never trusts a client to sum anything.

/// <summary>The settings that make an item a finance root.</summary>
public sealed record FinanceSettingsRequest(string Currency, string StartMonth, int HorizonMonths, decimal OpeningCash, decimal EmergencyFundMonths, string Timezone);

public sealed record FinanceSettingsResponse(string Currency, string StartMonth, string EndMonth, int HorizonMonths, decimal OpeningCash, decimal EmergencyFundMonths, string Timezone);

/// <summary>The containers the root keeps its records in; ordinary items with ordinary views.</summary>
public sealed record FinanceContainersResponse(Guid Accounts, Guid Lines, Guid Transactions);

public sealed record FinanceAccountRequest(string Name, string Type, decimal? Limit, decimal OpeningBalance, Guid? SettlesFrom, decimal? Apr, decimal? Payment, decimal? Overpayment, decimal? Target, bool Archived = false);

public sealed record FinanceAccountResponse(Guid Id, string Name, string Type, decimal? Limit, decimal OpeningBalance, Guid? SettlesFrom, decimal? Apr, decimal? Payment, decimal? Overpayment, decimal? Target, bool Archived);

/// <summary>A planned line. Overrides are keyed by yyyy-MM.</summary>
public sealed record BudgetLineRequest(string Name, string Section, string Flow, Guid AccountId, decimal Amount, IReadOnlyDictionary<string, decimal>? Overrides, bool Scheduled, int? DueDay, Guid? LoanAccount, bool Archived = false);

public sealed record BudgetLineResponse(Guid Id, string Name, string Section, string Flow, Guid AccountId, decimal Amount, IReadOnlyDictionary<string, decimal> Overrides, bool Scheduled, int? DueDay, Guid? LoanAccount, bool Archived, long Position);

/// <summary>A transaction as recorded by hand. Amount is the cash effect: negative when money left.</summary>
public sealed record FinanceTransactionRequest(string Description, DateOnly Date, decimal Amount, Guid AccountId, Guid? LineId, bool Cleared = false);

public sealed record FinanceTransactionResponse(Guid Id, string Description, DateOnly Date, decimal Amount, Guid AccountId, Guid? LineId, string Source, string? PostedFor, string? ImportKey, bool Cleared);

/// <summary>The root as configured, with every account and line and the months already closed.</summary>
/// <param name="Problems">Records that could not be read, so a broken row is seen rather than silently dropped.</param>
public sealed record FinanceResponse(
    Guid ItemId,
    FinanceSettingsResponse Settings,
    FinanceContainersResponse Containers,
    IReadOnlyList<FinanceAccountResponse> Accounts,
    IReadOnlyList<BudgetLineResponse> Lines,
    IReadOnlyList<string> ClosedMonths,
    string CurrentMonth,
    int TransactionCount,
    IReadOnlyList<string> Problems);

public sealed record FinanceTransactionsResponse(IReadOnlyList<FinanceTransactionResponse> Transactions, int Total, bool Truncated);

public sealed record BudgetCellResponse(string Month, decimal Plan, decimal Actual, decimal Variance, int Transactions);

public sealed record BudgetLineRowResponse(BudgetLineResponse Line, IReadOnlyList<BudgetCellResponse> Cells);

public sealed record BudgetSectionResponse(string Name, string Flow, IReadOnlyList<BudgetLineRowResponse> Lines, IReadOnlyList<BudgetCellResponse> Totals);

public sealed record MonthFiguresResponse(decimal Income, decimal PaidThisMonth, decimal CardSpend, decimal Outgoings, decimal Net);

public sealed record BudgetMonthTotalsResponse(string Month, bool Closed, MonthFiguresResponse Plan, MonthFiguresResponse Actual, decimal UnassignedOutflow, decimal UnassignedInflow, int UnassignedTransactions, decimal CumulativeNetPlan, decimal CumulativeNetActual);

/// <summary>Lines down the side, months across, from both sources; the client draws Plan, Actual or Variance.</summary>
public sealed record BudgetGridResponse(Guid ItemId, IReadOnlyList<string> Months, IReadOnlyList<BudgetSectionResponse> Sections, IReadOnlyList<BudgetMonthTotalsResponse> Totals);

public sealed record CardMonthResponse(Guid AccountId, string Name, string Month, string Source, decimal Opening, decimal Spend, decimal PaymentOut, decimal Closing, decimal? Utilisation, decimal? Limit, Guid? SettlesFrom);

public sealed record LoanSummaryResponse(decimal Opening, decimal Apr, decimal Payment, decimal Overpayment, int MonthsToClear, decimal TotalInterest, decimal TotalPaid, bool Cleared, string? ClearedIn, decimal BalanceAfterMonth);

/// <summary>An account with the figure that matters for its type in the month asked about.</summary>
/// <param name="RecordedBalance">For cash accounts: the opening balance plus every recorded transaction.</param>
public sealed record FinanceAccountSummaryResponse(FinanceAccountResponse Account, decimal? RecordedBalance, CardMonthResponse? Card, LoanSummaryResponse? Loan, decimal? SavingsProgress);

public sealed record FinanceAccountsResponse(Guid ItemId, string Month, IReadOnlyList<FinanceAccountSummaryResponse> Accounts);

public sealed record LoanMonthResponse(int Number, string Month, decimal Opening, decimal Interest, decimal Payment, decimal Principal, decimal Closing);

/// <summary>The schedule as configured, and the schedule with the overpayment asked about, side by side.</summary>
public sealed record LoanScheduleResponse(Guid AccountId, string Name, LoanSummaryResponse Baseline, LoanSummaryResponse Alternative, int MonthsSaved, decimal InterestSaved, IReadOnlyList<LoanMonthResponse> Months);

public sealed record CashFlowMonthResponse(string Month, string Source, decimal Income, decimal PaidThisMonth, decimal CardSpend, decimal CardPaymentOut, decimal CashNet, decimal ClosingBank, decimal CardOwed, decimal NetPosition, decimal EmergencyTarget, bool BufferMet);

public sealed record CashFlowResponse(Guid ItemId, decimal OpeningBank, decimal OpeningCardOwed, decimal OpeningNetPosition, decimal EmergencyTarget, string EmergencyBasisMonth, string? BufferMetIn, IReadOnlyList<CashFlowMonthResponse> Months);

/// <summary>A spending line over its plan, or money recorded against no line at all when LineId is null.</summary>
public sealed record WatchItemResponse(Guid? LineId, string Name, string Section, decimal Plan, decimal Actual, decimal Variance);

/// <summary>Something that will leave an account soon: a scheduled line, or a card statement.</summary>
public sealed record UpcomingResponse(string Kind, Guid? LineId, Guid? AccountId, string Name, DateOnly Due, decimal Amount, bool Posted);

public sealed record LoanPositionResponse(Guid AccountId, string Name, decimal Balance, string? ClearedIn, decimal TotalInterest);

public sealed record FinanceDashboardResponse(
    Guid ItemId,
    string Month,
    bool Closed,
    MonthFiguresResponse Plan,
    MonthFiguresResponse Actual,
    decimal? SavingsRatePlan,
    decimal? SavingsRateActual,
    CashFlowMonthResponse Position,
    decimal OpeningNetPosition,
    decimal EmergencyTarget,
    string? BufferMetIn,
    decimal CardFloat,
    IReadOnlyList<CardMonthResponse> Cards,
    IReadOnlyList<LoanPositionResponse> Loans,
    IReadOnlyList<WatchItemResponse> Watch,
    IReadOnlyList<UpcomingResponse> Upcoming,
    CashFlowMonthResponse HorizonEnd,
    decimal HorizonNet);

public sealed record FinanceMonthRequest(bool Closed);

public sealed record FinanceMonthResponse(string Month, bool Closed, IReadOnlyList<string> ClosedMonths);

/// <summary>What closing a month would leave unresolved.</summary>
public sealed record MonthChecklistResponse(string Month, bool Closed, int ScheduledPosted, int ScheduledUnposted, int UnassignedTransactions, decimal UnassignedOutflow, IReadOnlyList<WatchItemResponse> OverPlan, MonthFiguresResponse Plan, MonthFiguresResponse Actual);

public sealed record PostScheduledResponse(string Month, IReadOnlyList<FinanceTransactionResponse> Posted, int AlreadyPosted, int Skipped);

/// <summary>A bank export to read into an account; with Commit false it is only previewed.</summary>
public sealed record FinanceImportRequest(Guid AccountId, string Csv, bool Commit);

public sealed record FinanceImportRowResponse(int Row, DateOnly? Date, decimal? Amount, string Description, string Status, Guid? SuggestedLineId, string? Problem, Guid? TransactionId);

public sealed record FinanceImportResponse(int Rows, int Readable, int Created, int Duplicates, int Matched, int Unreadable, bool Committed, IReadOnlyList<FinanceImportRowResponse> Preview, string? Problem);
