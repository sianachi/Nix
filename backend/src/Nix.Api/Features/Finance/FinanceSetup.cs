using System.Text.Json.Nodes;
using Nix.Abstractions;
using Nix.Domain.Finance;
using Nix.Domain.Items;
using Nix.Domain.Primitives;
using Nix.Features.Items;
using Nix.Features.Properties;
using Nix.Messaging;

namespace Nix.Features.Finance;

/// <summary>Makes an item a finance root, or changes its settings; creates its containers the first time.</summary>
public sealed record SetFinanceSettings(ItemId ItemId, FinanceSettingsRequest Settings) : ICommand<FinanceResponse>;
/// <summary>Reads a root's settings, accounts, lines and closed months.</summary>
public sealed record ReadFinance(ItemId ItemId) : IQuery<Result<FinanceResponse>>;
public sealed record CreateFinanceAccount(ItemId ItemId, FinanceAccountRequest Account) : ICommand<FinanceAccountResponse>;
public sealed record SetFinanceAccount(ItemId ItemId, Guid AccountId, FinanceAccountRequest Account) : ICommand<FinanceAccountResponse>;
public sealed record CreateBudgetLine(ItemId ItemId, BudgetLineRequest Line) : ICommand<BudgetLineResponse>;
public sealed record SetBudgetLine(ItemId ItemId, Guid LineId, BudgetLineRequest Line) : ICommand<BudgetLineResponse>;

/// <summary>Setting up: the root, its accounts and its plan. Records are ordinary items written through the item commands.</summary>
public sealed class FinanceSetupHandler(FinanceLoader loader, IFinanceLock financeLock, NixDispatcher dispatcher, TimeProvider clock) :
    ICommandHandler<SetFinanceSettings, FinanceResponse>,
    IQueryHandler<ReadFinance, Result<FinanceResponse>>,
    ICommandHandler<CreateFinanceAccount, FinanceAccountResponse>,
    ICommandHandler<SetFinanceAccount, FinanceAccountResponse>,
    ICommandHandler<CreateBudgetLine, BudgetLineResponse>,
    ICommandHandler<SetBudgetLine, BudgetLineResponse>
{
    internal const string RecordType = "note";

    /// <inheritdoc />
    public async ValueTask<Result<FinanceResponse>> HandleAsync(SetFinanceSettings command, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(command);
        ArgumentNullException.ThrowIfNull(command.Settings);
        var request = command.Settings;
        if (!YearMonth.TryParse(request.StartMonth, out var start))
        {
            return FinanceErrors.Failure<FinanceResponse>("invalid_settings", "The start month must be yyyy-MM.");
        }
        var settings = new FinanceSettings(request.Currency?.Trim().ToUpperInvariant() ?? string.Empty, start, request.HorizonMonths, request.OpeningCash, request.EmergencyFundMonths, request.Timezone?.Trim() ?? string.Empty);
        if (settings.Validate() is { } invalid)
        {
            return FinanceErrors.Failure<FinanceResponse>("invalid_settings", invalid);
        }
        var rootResult = await loader.RootAsync(command.ItemId, true, cancellationToken).ConfigureAwait(false);
        if (rootResult.IsFailure)
        {
            return Result.Failure<FinanceResponse>(rootResult.Error);
        }
        await financeLock.AcquireWorkspaceTopologyAsync(rootResult.Value.WorkspaceId, cancellationToken).ConfigureAwait(false);
        await financeLock.AcquireAsync(command.ItemId, cancellationToken).ConfigureAwait(false);
        var root = await loader.RootAsync(command.ItemId, true, cancellationToken).ConfigureAwait(false);
        if (root.IsFailure)
        {
            return Result.Failure<FinanceResponse>(root.Error);
        }
        var properties = settings.ToProperties();
        var bag = FinanceJson.Bag(root.Value.Properties);
        var hasFinanceState = bag.Any(pair => pair.Key.StartsWith(FinanceKeys.Prefix, StringComparison.Ordinal));
        var configured = FinanceSettings.IsConfigured(root.Value.Properties);
        if (hasFinanceState && !configured)
        {
            return FinanceErrors.Failure<FinanceResponse>("invalid_settings", "This item contains incomplete finance settings. Repair them before setting it up again.");
        }
        if (configured)
        {
            var snapshot = await LoadConfiguredAsync(root.Value, cancellationToken).ConfigureAwait(false);
            if (snapshot.IsFailure)
            {
                return Result.Failure<FinanceResponse>(snapshot.Error);
            }
            if (RefuseSettingsChange(snapshot.Value, settings) is { } historyProblem)
            {
                return FinanceErrors.Failure<FinanceResponse>("closed_history", historyProblem);
            }
        }
        else
        {
            var accounts = await CreateAsync(root.Value, root.Value.Id, "Accounts", null, cancellationToken).ConfigureAwait(false);
            if (accounts.IsFailure)
            {
                return Result.Failure<FinanceResponse>(accounts.Error);
            }
            var lines = await CreateAsync(root.Value, root.Value.Id, "Budget lines", null, cancellationToken).ConfigureAwait(false);
            if (lines.IsFailure)
            {
                return Result.Failure<FinanceResponse>(lines.Error);
            }
            var transactions = await CreateAsync(root.Value, root.Value.Id, "Transactions", null, cancellationToken).ConfigureAwait(false);
            if (transactions.IsFailure)
            {
                return Result.Failure<FinanceResponse>(transactions.Error);
            }
            foreach (var (key, value) in new FinanceContainers(accounts.Value.Id.Value, lines.Value.Id.Value, transactions.Value.Id.Value).ToProperties())
            {
                properties[key] = value?.DeepClone();
            }
            properties[FinanceKeys.ClosedMonths] = FinanceJson.WriteMonths([]);
        }
        var written = await dispatcher.SendAsync<SetItemProperties, Item>(new SetItemProperties(command.ItemId, properties.ToJsonString()) { FinanceWrite = true }, cancellationToken).ConfigureAwait(false);
        if (written.IsFailure)
        {
            return Result.Failure<FinanceResponse>(written.Error);
        }
        return await HandleAsync(new ReadFinance(command.ItemId), cancellationToken).ConfigureAwait(false);
    }

    /// <inheritdoc />
    public async ValueTask<Result<FinanceResponse>> HandleAsync(ReadFinance query, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(query);
        var root = await loader.RootAsync(query.ItemId, false, cancellationToken).ConfigureAwait(false);
        if (root.IsFailure)
        {
            return Result.Failure<FinanceResponse>(root.Error);
        }
        var snapshot = await loader.LoadAsync(root.Value, cancellationToken).ConfigureAwait(false);
        if (snapshot.IsFailure)
        {
            return Result.Failure<FinanceResponse>(snapshot.Error);
        }
        return Result.Success(Describe(snapshot.Value));
    }

    /// <inheritdoc />
    public async ValueTask<Result<FinanceAccountResponse>> HandleAsync(CreateFinanceAccount command, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(command);
        ArgumentNullException.ThrowIfNull(command.Account);
        var snapshot = await LockedSnapshotAsync(command.ItemId, cancellationToken).ConfigureAwait(false);
        if (snapshot.IsFailure)
        {
            return Result.Failure<FinanceAccountResponse>(snapshot.Error);
        }
        var account = command.Account.ToAccount(Guid.NewGuid());
        if (Refuse(account, snapshot.Value.Book) is { } invalid)
        {
            return FinanceErrors.Failure<FinanceAccountResponse>("invalid_account", invalid);
        }
        if (snapshot.Value.Book.ClosedMonths.Any() && account.OpeningBalance != 0m)
        {
            return FinanceErrors.Failure<FinanceAccountResponse>("closed_history", "A new account with an opening balance cannot be added after months have been closed. Reopen the months first.");
        }
        if (snapshot.Value.Book.Accounts.Count >= FinanceLoader.MaximumAccounts)
        {
            return FinanceErrors.Failure<FinanceAccountResponse>("limit", $"A finance root holds at most {FinanceLoader.MaximumAccounts} accounts.");
        }
        var created = await CreateAsync(snapshot.Value.Root, ItemId.From(snapshot.Value.Containers.Accounts), account.Name, account.ToProperties(), cancellationToken).ConfigureAwait(false);
        return created.IsFailure
            ? Result.Failure<FinanceAccountResponse>(created.Error)
            : Result.Success((account with { Id = created.Value.Id.Value }).ToResponse());
    }

    /// <inheritdoc />
    public async ValueTask<Result<FinanceAccountResponse>> HandleAsync(SetFinanceAccount command, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(command);
        ArgumentNullException.ThrowIfNull(command.Account);
        var snapshot = await LockedSnapshotAsync(command.ItemId, cancellationToken).ConfigureAwait(false);
        if (snapshot.IsFailure)
        {
            return Result.Failure<FinanceAccountResponse>(snapshot.Error);
        }
        if (!snapshot.Value.Book.AccountsById.TryGetValue(command.AccountId, out var existing))
        {
            return FinanceErrors.Failure<FinanceAccountResponse>("account_not_found", "No such account under this finance root.");
        }
        var account = command.Account.ToAccount(command.AccountId);
        if (Refuse(account, snapshot.Value.Book) is { } invalid)
        {
            return FinanceErrors.Failure<FinanceAccountResponse>("invalid_account", invalid);
        }
        if (snapshot.Value.Book.ClosedMonths.Any() && ChangesClosedAccountHistory(existing, account))
        {
            return FinanceErrors.Failure<FinanceAccountResponse>("closed_history", "Account type, opening balance, settlement, credit terms and archive status cannot change while months are closed. Reopen the months first.");
        }
        var written = await WriteAsync(ItemId.From(command.AccountId), existing.Name, account.Name, account.ToProperties(), cancellationToken).ConfigureAwait(false);
        return written.IsFailure ? Result.Failure<FinanceAccountResponse>(written.Error) : Result.Success(account.ToResponse());
    }

    /// <inheritdoc />
    public async ValueTask<Result<BudgetLineResponse>> HandleAsync(CreateBudgetLine command, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(command);
        ArgumentNullException.ThrowIfNull(command.Line);
        var snapshot = await LockedSnapshotAsync(command.ItemId, cancellationToken).ConfigureAwait(false);
        if (snapshot.IsFailure)
        {
            return Result.Failure<BudgetLineResponse>(snapshot.Error);
        }
        var (line, problem) = command.Line.ToLine(Guid.NewGuid(), 0);
        if (line is null || Refuse(line, snapshot.Value.Book) is { } invalid)
        {
            return FinanceErrors.Failure<BudgetLineResponse>("invalid_line", problem ?? Refuse(line!, snapshot.Value.Book)!);
        }
        if (snapshot.Value.Book.Lines.Count >= FinanceLoader.MaximumLines)
        {
            return FinanceErrors.Failure<BudgetLineResponse>("limit", $"A finance root holds at most {FinanceLoader.MaximumLines} budget lines.");
        }
        if (RefuseClosedLinePlan(snapshot.Value.Book, null, line) is { } historyProblem)
        {
            return FinanceErrors.Failure<BudgetLineResponse>("closed_history", historyProblem);
        }
        var created = await CreateAsync(snapshot.Value.Root, ItemId.From(snapshot.Value.Containers.Lines), line.Name, line.ToProperties(), cancellationToken).ConfigureAwait(false);
        return created.IsFailure
            ? Result.Failure<BudgetLineResponse>(created.Error)
            : Result.Success((line with { Id = created.Value.Id.Value, Position = created.Value.Seq }).ToResponse());
    }

    /// <inheritdoc />
    public async ValueTask<Result<BudgetLineResponse>> HandleAsync(SetBudgetLine command, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(command);
        ArgumentNullException.ThrowIfNull(command.Line);
        var snapshot = await LockedSnapshotAsync(command.ItemId, cancellationToken).ConfigureAwait(false);
        if (snapshot.IsFailure)
        {
            return Result.Failure<BudgetLineResponse>(snapshot.Error);
        }
        if (!snapshot.Value.Book.LinesById.TryGetValue(command.LineId, out var existing))
        {
            return FinanceErrors.Failure<BudgetLineResponse>("line_not_found", "No such budget line under this finance root.");
        }
        var (line, problem) = command.Line.ToLine(command.LineId, existing.Position);
        if (line is null || Refuse(line, snapshot.Value.Book) is { } invalid)
        {
            return FinanceErrors.Failure<BudgetLineResponse>("invalid_line", problem ?? Refuse(line!, snapshot.Value.Book)!);
        }
        if (RefuseClosedLinePlan(snapshot.Value.Book, existing, line) is { } historyProblem)
        {
            return FinanceErrors.Failure<BudgetLineResponse>("closed_history", historyProblem);
        }
        var written = await WriteAsync(ItemId.From(command.LineId), existing.Name, line.Name, line.ToProperties(), cancellationToken).ConfigureAwait(false);
        return written.IsFailure ? Result.Failure<BudgetLineResponse>(written.Error) : Result.Success(line.ToResponse());
    }

    internal FinanceResponse Describe(FinanceSnapshot snapshot)
    {
        var book = snapshot.Book;
        return new FinanceResponse(
            snapshot.Root.Id.Value,
            snapshot.Settings.ToResponse(),
            snapshot.Containers.ToResponse(),
            book.Accounts.Select(account => account.ToResponse()).ToList(),
            book.Lines.Select(line => line.ToResponse()).ToList(),
            book.ClosedMonths.Select(month => month.ToString()).ToList(),
            snapshot.Settings.CurrentMonth(clock.GetUtcNow()).ToString(),
            book.Transactions.Count,
            snapshot.Problems);
    }

    private async ValueTask<Result<FinanceSnapshot>> LoadConfiguredAsync(Item root, CancellationToken cancellationToken)
    {
        var bag = FinanceJson.Bag(root.Properties);
        if (!bag.ContainsKey(FinanceKeys.ClosedMonths)
            || FinanceJson.Months(bag, FinanceKeys.ClosedMonths) is not { } closed)
        {
            return FinanceErrors.Failure<FinanceSnapshot>("invalid_closed_months", "The closed-month history is missing or damaged. Correct it before changing this finance root.");
        }

        var loaded = await loader.LoadAsync(root, cancellationToken).ConfigureAwait(false);
        if (loaded.IsFailure)
        {
            return Result.Failure<FinanceSnapshot>(loaded.Error);
        }

        if (closed.Distinct().Count() != closed.Count
            || closed.Any(month => !loaded.Value.Settings.Covers(month)))
        {
            return FinanceErrors.Failure<FinanceSnapshot>("invalid_closed_months", "The closed-month history contains a duplicate or a month outside this plan. Correct it before changing this finance root.");
        }
        if (closed.Count > 0 && loaded.Value.Problems.Count > 0)
        {
            return FinanceErrors.Failure<FinanceSnapshot>("closed_history_damaged", "This finance root has unreadable records and closed months. Repair its history before changing it.");
        }

        return loaded;
    }

    private static string? RefuseSettingsChange(FinanceSnapshot snapshot, FinanceSettings next)
    {
        var book = snapshot.Book;
        if (book.Transactions.Any(transaction => !next.Covers(transaction.Month)))
        {
            return "The plan window cannot exclude a month that contains transactions.";
        }

        var closed = book.ClosedMonths.ToArray();
        if (closed.Length == 0)
        {
            return null;
        }

        if (!string.Equals(snapshot.Settings.Currency, next.Currency, StringComparison.Ordinal)
            || snapshot.Settings.StartMonth != next.StartMonth
            || snapshot.Settings.OpeningCash != next.OpeningCash)
        {
            return "Currency, start month and opening cash cannot change while months are closed. Reopen the months first.";
        }

        foreach (var month in closed)
        {
            if (!next.Covers(month))
            {
                return $"The plan window cannot exclude closed month {month}. Reopen it first.";
            }

            var outgoings = book.Figures(month, FigureSource.Plan).Outgoings;
            var existingTarget = MoneyRules.Round(snapshot.Settings.EmergencyFundMonths * outgoings);
            var nextTarget = MoneyRules.Round(next.EmergencyFundMonths * outgoings);
            if (existingTarget != nextTarget)
            {
                return $"The emergency target for closed month {month} cannot change. Reopen it first.";
            }
        }

        return null;
    }

    private static bool ChangesClosedAccountHistory(FinanceAccount existing, FinanceAccount next) =>
        existing.Type != next.Type
        || existing.Limit != next.Limit
        || existing.OpeningBalance != next.OpeningBalance
        || existing.SettlesFrom != next.SettlesFrom
        || existing.Apr != next.Apr
        || existing.Payment != next.Payment
        || existing.Overpayment != next.Overpayment
        || existing.Archived != next.Archived;

    private static string? RefuseClosedLinePlan(FinanceBook book, BudgetLine? existing, BudgetLine next)
    {
        var closed = book.ClosedMonths.ToArray();
        if (closed.Length == 0)
        {
            return null;
        }

        if (existing is not null && (existing.AccountId != next.AccountId || existing.Flow != next.Flow))
        {
            return "A budget line's account and flow cannot change while months are closed. Reopen the months first.";
        }

        foreach (var month in closed)
        {
            var previousOutgoings = existing is { IsIncome: false } ? book.Plan(existing, month) : 0m;
            var nextOutgoings = next.IsIncome ? 0m : book.Plan(next, month);
            if (previousOutgoings != nextOutgoings)
            {
                return $"The planned outgoings for closed month {month} cannot change because they set its emergency target. Reopen it first.";
            }
        }

        return null;
    }

    /// <summary>The root under the lock, loaded after the lock so the snapshot is the one the write acts on.</summary>
    private async ValueTask<Result<FinanceSnapshot>> LockedSnapshotAsync(ItemId itemId, CancellationToken cancellationToken)
    {
        var root = await loader.RootAsync(itemId, true, cancellationToken).ConfigureAwait(false);
        if (root.IsFailure)
        {
            return Result.Failure<FinanceSnapshot>(root.Error);
        }
        await financeLock.AcquireWorkspaceTopologyAsync(root.Value.WorkspaceId, cancellationToken).ConfigureAwait(false);
        await financeLock.AcquireAsync(itemId, cancellationToken).ConfigureAwait(false);
        root = await loader.RootAsync(itemId, true, cancellationToken).ConfigureAwait(false);
        return root.IsFailure ? Result.Failure<FinanceSnapshot>(root.Error) : await LoadConfiguredAsync(root.Value, cancellationToken).ConfigureAwait(false);
    }

    private static string? Refuse(FinanceAccount account, FinanceBook book)
    {
        if (account.Validate() is { } invalid)
        {
            return invalid;
        }
        if (account.SettlesFrom is { } settles)
        {
            if (!book.AccountsById.TryGetValue(settles, out var source))
            {
                return "The account a card settles from must be one of this root's accounts.";
            }
            if (source.IsCreditCard || source.IsLoan)
            {
                return "A card settles from a current, savings or debit account.";
            }
        }
        return null;
    }

    private static string? Refuse(BudgetLine line, FinanceBook book)
    {
        if (line.Validate() is { } invalid)
        {
            return invalid;
        }
        if (!book.AccountsById.TryGetValue(line.AccountId, out var account))
        {
            return "A budget line is paid from one of this root's accounts.";
        }
        if (account.IsLoan)
        {
            return "A budget line is paid from a cash account or a card, not from the loan itself; name the loan in loanAccount instead.";
        }
        if (line.IsIncome && account.IsCreditCard)
        {
            return "Income is received into a cash account, not a credit card.";
        }
        if (line.LoanAccount is { } loanId && (!book.AccountsById.TryGetValue(loanId, out var loan) || !loan.IsLoan))
        {
            return "A loan repayment line names one of this root's loan accounts.";
        }
        return null;
    }

    private async ValueTask<Result<Item>> CreateAsync(Item root, ItemId parent, string title, JsonObject? properties, CancellationToken cancellationToken) =>
        await dispatcher.SendAsync<CreateItem, Item>(new CreateItem(root.WorkspaceId, RecordType, title, parent, properties) { FinanceWrite = true }, cancellationToken).ConfigureAwait(false);

    private async ValueTask<Result<Item>> WriteAsync(ItemId itemId, string previousName, string name, JsonObject properties, CancellationToken cancellationToken)
    {
        if (!string.Equals(previousName, name, StringComparison.Ordinal))
        {
            var renamed = await dispatcher.SendAsync<RenameItem, Item>(new RenameItem(itemId, name) { FinanceWrite = true }, cancellationToken).ConfigureAwait(false);
            if (renamed.IsFailure)
            {
                return renamed;
            }
        }
        return await dispatcher.SendAsync<SetItemProperties, Item>(new SetItemProperties(itemId, properties.ToJsonString()) { FinanceWrite = true }, cancellationToken).ConfigureAwait(false);
    }
}
