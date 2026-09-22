using Nix.Domain.Finance;
using Nix.Domain.Items;
using Nix.Domain.Primitives;
using Nix.Messaging;

namespace Nix.Features.Finance;

/// <summary>Lines by month, defaulting to the current month alone.</summary>
public sealed record ReadBudgetGrid(ItemId ItemId, YearMonth? From, YearMonth? To) : IQuery<Result<BudgetGridResponse>>;
/// <summary>Every account with the figure that matters for it in a month.</summary>
public sealed record ReadFinanceAccounts(ItemId ItemId, YearMonth? Month) : IQuery<Result<FinanceAccountsResponse>>;
/// <summary>A loan's schedule as configured, and with a different overpayment beside it.</summary>
public sealed record ReadLoanSchedule(ItemId ItemId, Guid AccountId, decimal? Overpayment) : IQuery<Result<LoanScheduleResponse>>;
public sealed record ReadCashFlow(ItemId ItemId) : IQuery<Result<CashFlowResponse>>;
public sealed record ReadFinanceDashboard(ItemId ItemId, YearMonth? Month) : IQuery<Result<FinanceDashboardResponse>>;
/// <summary>Transactions, newest first, narrowed by month, account or line; Unassigned keeps only those with no line.</summary>
public sealed record ListFinanceTransactions(ItemId ItemId, YearMonth? Month, Guid? AccountId, Guid? LineId, bool Unassigned, int Limit) : IQuery<Result<FinanceTransactionsResponse>>;
/// <summary>What closing a month would leave unresolved.</summary>
public sealed record ReadFinanceMonth(ItemId ItemId, YearMonth Month) : IQuery<Result<MonthChecklistResponse>>;

/// <summary>Every figure the module derives, computed on read from the items and never stored.</summary>
public sealed class FinanceReportHandler(FinanceLoader loader, TimeProvider clock) :
    IQueryHandler<ReadBudgetGrid, Result<BudgetGridResponse>>,
    IQueryHandler<ReadFinanceAccounts, Result<FinanceAccountsResponse>>,
    IQueryHandler<ReadLoanSchedule, Result<LoanScheduleResponse>>,
    IQueryHandler<ReadCashFlow, Result<CashFlowResponse>>,
    IQueryHandler<ReadFinanceDashboard, Result<FinanceDashboardResponse>>,
    IQueryHandler<ListFinanceTransactions, Result<FinanceTransactionsResponse>>,
    IQueryHandler<ReadFinanceMonth, Result<MonthChecklistResponse>>
{
    public const int MaximumTransactionsPage = 1000;
    public const int DefaultTransactionsPage = 500;
    public const int UpcomingDays = 14;
    public const int MaximumWatchItems = 8;

    /// <inheritdoc />
    public async ValueTask<Result<BudgetGridResponse>> HandleAsync(ReadBudgetGrid query, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(query);
        var snapshot = await SnapshotAsync(query.ItemId, cancellationToken).ConfigureAwait(false);
        if (snapshot.IsFailure)
        {
            return Result.Failure<BudgetGridResponse>(snapshot.Error);
        }
        var settings = snapshot.Value.Settings;
        var from = query.From ?? query.To ?? settings.CurrentMonth(clock.GetUtcNow());
        var to = query.To ?? from;
        if (to < from || to.Index - from.Index >= BudgetGrids.MaximumMonths)
        {
            return FinanceErrors.Failure<BudgetGridResponse>("invalid_range", $"Choose an ordered range of at most {BudgetGrids.MaximumMonths} months.");
        }
        return Result.Success(BudgetGrids.Compute(snapshot.Value.Book, from, to).ToResponse(query.ItemId.Value));
    }

    /// <inheritdoc />
    public async ValueTask<Result<FinanceAccountsResponse>> HandleAsync(ReadFinanceAccounts query, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(query);
        var snapshot = await SnapshotAsync(query.ItemId, cancellationToken).ConfigureAwait(false);
        if (snapshot.IsFailure)
        {
            return Result.Failure<FinanceAccountsResponse>(snapshot.Error);
        }
        var book = snapshot.Value.Book;
        var month = query.Month ?? snapshot.Value.Settings.CurrentMonth(clock.GetUtcNow());
        var summaries = new List<FinanceAccountSummaryResponse>();
        foreach (var account in book.Accounts)
        {
            CardMonthResponse? card = null;
            LoanSummaryResponse? loan = null;
            decimal? recorded = null;
            decimal? progress = null;
            if (account.IsCreditCard)
            {
                card = CardCycles.Compute(book, account, FigureSource.Auto, month, month).For(month)?.ToResponse(account);
            }
            else if (account.IsLoan)
            {
                loan = LoanSchedules.Compute(account, snapshot.Value.Settings.StartMonth).ToSummary(month);
            }
            else
            {
                recorded = account.OpeningBalance + book.Transactions
                    .Where(transaction => transaction.AccountId == account.Id && transaction.Date <= month.LastDay)
                    .Sum(transaction => transaction.Amount);
                if (account.Target is { } target && target > 0)
                {
                    progress = decimal.Round(recorded.Value / target, 4);
                }
            }
            summaries.Add(new FinanceAccountSummaryResponse(account.ToResponse(), recorded, card, loan, progress));
        }
        return Result.Success(new FinanceAccountsResponse(query.ItemId.Value, month.ToString(), summaries));
    }

    /// <inheritdoc />
    public async ValueTask<Result<LoanScheduleResponse>> HandleAsync(ReadLoanSchedule query, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(query);
        if (query.Overpayment is { } over && (!MoneyRules.IsAmount(over) || over < 0))
        {
            return FinanceErrors.Failure<LoanScheduleResponse>("invalid_account", "An overpayment is an amount of zero or more.");
        }
        var snapshot = await SnapshotAsync(query.ItemId, cancellationToken).ConfigureAwait(false);
        if (snapshot.IsFailure)
        {
            return Result.Failure<LoanScheduleResponse>(snapshot.Error);
        }
        if (!snapshot.Value.Book.AccountsById.TryGetValue(query.AccountId, out var loan) || !loan.IsLoan)
        {
            return FinanceErrors.Failure<LoanScheduleResponse>("account_not_found", "No such loan under this finance root.");
        }
        var start = snapshot.Value.Settings.StartMonth;
        var current = snapshot.Value.Settings.CurrentMonth(clock.GetUtcNow());
        var baseline = LoanSchedules.Compute(loan, start);
        var alternative = query.Overpayment is null ? baseline : LoanSchedules.Compute(loan, start, query.Overpayment);
        var comparison = new LoanComparison(baseline, alternative);
        return Result.Success(new LoanScheduleResponse(
            loan.Id,
            loan.Name,
            baseline.ToSummary(current),
            alternative.ToSummary(current),
            comparison.MonthsSaved,
            comparison.InterestSaved,
            alternative.Months.Select(month => month.ToResponse()).ToList()));
    }

    /// <inheritdoc />
    public async ValueTask<Result<CashFlowResponse>> HandleAsync(ReadCashFlow query, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(query);
        var snapshot = await SnapshotAsync(query.ItemId, cancellationToken).ConfigureAwait(false);
        if (snapshot.IsFailure)
        {
            return Result.Failure<CashFlowResponse>(snapshot.Error);
        }
        var current = snapshot.Value.Settings.CurrentMonth(clock.GetUtcNow());
        return Result.Success(CashFlowProjections.Compute(snapshot.Value.Book, current).ToResponse(query.ItemId.Value));
    }

    /// <inheritdoc />
    public async ValueTask<Result<FinanceDashboardResponse>> HandleAsync(ReadFinanceDashboard query, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(query);
        var snapshot = await SnapshotAsync(query.ItemId, cancellationToken).ConfigureAwait(false);
        if (snapshot.IsFailure)
        {
            return Result.Failure<FinanceDashboardResponse>(snapshot.Error);
        }
        var settings = snapshot.Value.Settings;
        var book = snapshot.Value.Book;
        var now = clock.GetUtcNow();
        var current = settings.CurrentMonth(now);
        var month = query.Month ?? current;
        if (!settings.Covers(month))
        {
            return FinanceErrors.Failure<FinanceDashboardResponse>("invalid_month", $"Choose a month between {settings.StartMonth} and {settings.EndMonth}.");
        }
        var plan = book.Figures(month, FigureSource.Plan);
        var actual = book.Figures(month, FigureSource.Actual);
        var projection = CashFlowProjections.Compute(book, current);
        var position = projection.For(month)!;
        var cards = book.Cards.Select(card => (Card: card, Row: CardCycles.Compute(book, card, FigureSource.Auto, month, month).For(month)!)).ToList();
        var loans = book.Loans.Select(loan =>
        {
            var schedule = LoanSchedules.Compute(loan, settings.StartMonth);
            return new LoanPositionResponse(loan.Id, loan.Name, LoanSchedules.BalanceAfter(schedule, month), schedule.ClearedIn?.ToString(), schedule.TotalInterest);
        }).ToList();
        var horizonNet = YearMonth.Range(settings.StartMonth, settings.EndMonth).Sum(each => book.Figures(each, FigureSource.Auto).Net);
        return Result.Success(new FinanceDashboardResponse(
            query.ItemId.Value,
            month.ToString(),
            book.IsClosed(month),
            plan.ToResponse(),
            actual.ToResponse(),
            plan.Income == 0 ? null : decimal.Round(plan.Net / plan.Income, 4),
            actual.Income == 0 ? null : decimal.Round(actual.Net / actual.Income, 4),
            position.ToResponse(),
            projection.OpeningNetPosition,
            position.EmergencyTarget,
            projection.BufferMetIn?.ToString(),
            cards.Sum(pair => pair.Row.Closing),
            cards.Select(pair => pair.Row.ToResponse(pair.Card)).ToList(),
            loans,
            Watch(book, month),
            Upcoming(book, settings.Today(now), cards),
            projection.Months[^1].ToResponse(),
            horizonNet));
    }

    /// <inheritdoc />
    public async ValueTask<Result<FinanceTransactionsResponse>> HandleAsync(ListFinanceTransactions query, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(query);
        var snapshot = await SnapshotAsync(query.ItemId, cancellationToken).ConfigureAwait(false);
        if (snapshot.IsFailure)
        {
            return Result.Failure<FinanceTransactionsResponse>(snapshot.Error);
        }
        var limit = query.Limit <= 0 ? DefaultTransactionsPage : Math.Min(query.Limit, MaximumTransactionsPage);
        var matching = snapshot.Value.Book.Transactions
            .Where(transaction => query.Month is not { } month || transaction.Month == month)
            .Where(transaction => query.AccountId is not { } account || transaction.AccountId == account)
            .Where(transaction => query.LineId is not { } line || transaction.LineId == line)
            .Where(transaction => !query.Unassigned || transaction.LineId is null)
            .OrderByDescending(transaction => transaction.Date)
            .ThenBy(transaction => transaction.Description, StringComparer.Ordinal)
            .ToList();
        return Result.Success(new FinanceTransactionsResponse(matching.Take(limit).Select(transaction => transaction.ToResponse()).ToList(), matching.Count, matching.Count > limit));
    }

    /// <inheritdoc />
    public async ValueTask<Result<MonthChecklistResponse>> HandleAsync(ReadFinanceMonth query, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(query);
        var snapshot = await SnapshotAsync(query.ItemId, cancellationToken).ConfigureAwait(false);
        if (snapshot.IsFailure)
        {
            return Result.Failure<MonthChecklistResponse>(snapshot.Error);
        }
        var book = snapshot.Value.Book;
        if (!snapshot.Value.Settings.Covers(query.Month))
        {
            return FinanceErrors.Failure<MonthChecklistResponse>("invalid_month", $"Choose a month between {snapshot.Value.Settings.StartMonth} and {snapshot.Value.Settings.EndMonth}.");
        }
        var (posted, unposted) = ScheduledCounts(book, query.Month);
        return Result.Success(new MonthChecklistResponse(
            query.Month.ToString(),
            book.IsClosed(query.Month),
            posted,
            unposted,
            book.UnassignedCount(query.Month),
            book.UnassignedOutflow(query.Month),
            Watch(book, query.Month),
            book.Figures(query.Month, FigureSource.Plan).ToResponse(),
            book.Figures(query.Month, FigureSource.Actual).ToResponse()));
    }

    internal static (int Posted, int Unposted) ScheduledCounts(FinanceBook book, YearMonth month)
    {
        int posted = 0, unposted = 0;
        foreach (var line in ScheduledLines(book, month))
        {
            if (IsPosted(book, line, month))
            {
                posted++;
            }
            else
            {
                unposted++;
            }
        }
        return (posted, unposted);
    }

    internal static IEnumerable<BudgetLine> ScheduledLines(FinanceBook book, YearMonth month) =>
        book.Lines.Where(line => line.Scheduled && !line.Archived && book.Plan(line, month) > 0);

    internal static bool IsPosted(FinanceBook book, BudgetLine line, YearMonth month) =>
        book.Transactions.Any(transaction => transaction.LineId == line.Id && transaction.PostedFor == month);

    private static List<WatchItemResponse> Watch(FinanceBook book, YearMonth month)
    {
        var watch = book.Lines
            .Where(line => !line.IsIncome)
            .Select(line => new WatchItemResponse(line.Id, line.Name, line.Section, book.Plan(line, month), book.Actual(line, month), book.Actual(line, month) - book.Plan(line, month)))
            .Where(item => item.Variance > 0)
            .OrderByDescending(item => item.Variance)
            .Take(MaximumWatchItems)
            .ToList();
        var unassigned = book.UnassignedOutflow(month);
        if (unassigned > 0)
        {
            watch.Insert(0, new WatchItemResponse(null, "Unassigned spending", "Unassigned", 0, unassigned, unassigned));
        }
        return watch;
    }

    private static List<UpcomingResponse> Upcoming(FinanceBook book, DateOnly today, List<(FinanceAccount Card, CardMonth Row)> cards)
    {
        var end = today.AddDays(UpcomingDays);
        var upcoming = new List<UpcomingResponse>();
        foreach (var month in new[] { YearMonth.Of(today), YearMonth.Of(today).AddMonths(1) })
        {
            if (!book.Settings.Covers(month))
            {
                continue;
            }
            foreach (var line in ScheduledLines(book, month))
            {
                var due = month.Day(line.DueDay ?? 1);
                if (due >= today && due <= end)
                {
                    upcoming.Add(new UpcomingResponse("line", line.Id, line.AccountId, line.Name, due, book.Plan(line, month), IsPosted(book, line, month)));
                }
            }
        }
        foreach (var (card, row) in cards)
        {
            var due = row.Month.AddMonths(1).FirstDay;
            if (row.Closing > 0 && due >= today && due <= end)
            {
                upcoming.Add(new UpcomingResponse("card", null, card.Id, $"{card.Name} statement", due, row.Closing, false));
            }
        }
        return upcoming.OrderBy(item => item.Due).ThenBy(item => item.Name, StringComparer.Ordinal).ToList();
    }

    private async ValueTask<Result<FinanceSnapshot>> SnapshotAsync(ItemId itemId, CancellationToken cancellationToken)
    {
        var root = await loader.RootAsync(itemId, false, cancellationToken).ConfigureAwait(false);
        return root.IsFailure ? Result.Failure<FinanceSnapshot>(root.Error) : await loader.LoadAsync(root.Value, cancellationToken).ConfigureAwait(false);
    }
}
