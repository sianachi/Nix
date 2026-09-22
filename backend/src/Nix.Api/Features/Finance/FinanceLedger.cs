using System.Text.Json.Nodes;
using Nix.Abstractions;
using Nix.Domain.Finance;
using Nix.Domain.Items;
using Nix.Domain.Primitives;
using Nix.Features.Items;
using Nix.Features.Properties;
using Nix.Messaging;

namespace Nix.Features.Finance;

/// <summary>Records a transaction by hand; a quick-add comes down to this.</summary>
public sealed record CreateFinanceTransaction(ItemId ItemId, FinanceTransactionRequest Transaction) : ICommand<FinanceTransactionResponse>;
/// <summary>Changes a transaction's date, amount, account, line or description; how it was recorded is kept.</summary>
public sealed record SetFinanceTransaction(ItemId ItemId, Guid TransactionId, FinanceTransactionRequest Transaction) : ICommand<FinanceTransactionResponse>;
/// <summary>Closes or reopens a month. Closing switches it from plan to actual everywhere.</summary>
public sealed record SetFinanceMonth(ItemId ItemId, YearMonth Month, FinanceMonthRequest Change) : ICommand<FinanceMonthResponse>;
/// <summary>Posts every scheduled line's planned amount for a month as a transaction, once.</summary>
public sealed record PostScheduledTransactions(ItemId ItemId, YearMonth Month) : ICommand<PostScheduledResponse>;
/// <summary>Reads a bank export into an account, skipping rows already recorded.</summary>
public sealed record ImportFinanceStatement(ItemId ItemId, FinanceImportRequest Import) : ICommand<FinanceImportResponse>;

/// <summary>Writing to the ledger. Every write takes the root's lock and re-reads before deciding.</summary>
public sealed class FinanceLedgerHandler(FinanceLoader loader, IFinanceLock financeLock, NixDispatcher dispatcher) :
    ICommandHandler<CreateFinanceTransaction, FinanceTransactionResponse>,
    ICommandHandler<SetFinanceTransaction, FinanceTransactionResponse>,
    ICommandHandler<SetFinanceMonth, FinanceMonthResponse>,
    ICommandHandler<PostScheduledTransactions, PostScheduledResponse>,
    ICommandHandler<ImportFinanceStatement, FinanceImportResponse>
{
    public const int MaximumPreviewRows = 500;

    /// <inheritdoc />
    public async ValueTask<Result<FinanceTransactionResponse>> HandleAsync(CreateFinanceTransaction command, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(command);
        ArgumentNullException.ThrowIfNull(command.Transaction);
        var snapshot = await LockedSnapshotAsync(command.ItemId, cancellationToken).ConfigureAwait(false);
        if (snapshot.IsFailure)
        {
            return Result.Failure<FinanceTransactionResponse>(snapshot.Error);
        }
        var book = snapshot.Value.Book;
        var request = command.Transaction;
        var transaction = new FinanceTransaction(Guid.NewGuid(), request.Description?.Trim() ?? string.Empty, request.Date, request.Amount, request.AccountId, request.LineId, FinanceSources.Manual, null, null, request.Cleared);
        if (Refuse(transaction, book) is { } refused)
        {
            return refused;
        }
        if (book.Transactions.Count >= FinanceLoader.MaximumTransactions)
        {
            return FinanceErrors.Failure<FinanceTransactionResponse>("limit", $"A finance root holds at most {FinanceLoader.MaximumTransactions:N0} transactions.");
        }
        var created = await CreateAsync(snapshot.Value, transaction, cancellationToken).ConfigureAwait(false);
        return created.IsFailure ? Result.Failure<FinanceTransactionResponse>(created.Error) : Result.Success(created.Value.ToResponse());
    }

    /// <inheritdoc />
    public async ValueTask<Result<FinanceTransactionResponse>> HandleAsync(SetFinanceTransaction command, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(command);
        ArgumentNullException.ThrowIfNull(command.Transaction);
        var snapshot = await LockedSnapshotAsync(command.ItemId, cancellationToken).ConfigureAwait(false);
        if (snapshot.IsFailure)
        {
            return Result.Failure<FinanceTransactionResponse>(snapshot.Error);
        }
        var book = snapshot.Value.Book;
        var existing = book.Transactions.FirstOrDefault(transaction => transaction.Id == command.TransactionId);
        if (existing is null)
        {
            return FinanceErrors.Failure<FinanceTransactionResponse>("transaction_not_found", "No such transaction under this finance root.");
        }
        if (book.IsClosed(existing.Month))
        {
            return FinanceErrors.Failure<FinanceTransactionResponse>("month_closed", $"{existing.Month} is closed. Reopen it to change what it recorded.");
        }
        var request = command.Transaction;
        if (existing.PostedFor is not null && request.LineId != existing.LineId)
        {
            return FinanceErrors.Failure<FinanceTransactionResponse>("invalid_transaction", "A scheduled transaction keeps the line and month it was posted for.");
        }
        var transaction = existing with
        {
            Description = request.Description?.Trim() ?? string.Empty,
            Date = request.Date,
            Amount = request.Amount,
            AccountId = request.AccountId,
            LineId = request.LineId,
            Cleared = request.Cleared,
        };
        if (Refuse(transaction, book) is { } refused)
        {
            return refused;
        }
        if (!string.Equals(existing.Description, transaction.Description, StringComparison.Ordinal))
        {
            var renamed = await dispatcher.SendAsync<RenameItem, Item>(new RenameItem(ItemId.From(transaction.Id), transaction.Description) { FinanceWrite = true }, cancellationToken).ConfigureAwait(false);
            if (renamed.IsFailure)
            {
                return Result.Failure<FinanceTransactionResponse>(renamed.Error);
            }
        }
        var written = await dispatcher.SendAsync<SetItemProperties, Item>(new SetItemProperties(ItemId.From(transaction.Id), transaction.ToProperties().ToJsonString()) { FinanceWrite = true }, cancellationToken).ConfigureAwait(false);
        return written.IsFailure ? Result.Failure<FinanceTransactionResponse>(written.Error) : Result.Success(transaction.ToResponse());
    }

    /// <inheritdoc />
    public async ValueTask<Result<FinanceMonthResponse>> HandleAsync(SetFinanceMonth command, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(command);
        ArgumentNullException.ThrowIfNull(command.Change);
        var snapshot = await LockedSnapshotAsync(command.ItemId, cancellationToken).ConfigureAwait(false);
        if (snapshot.IsFailure)
        {
            return Result.Failure<FinanceMonthResponse>(snapshot.Error);
        }
        if (!snapshot.Value.Settings.Covers(command.Month))
        {
            return FinanceErrors.Failure<FinanceMonthResponse>("invalid_month", $"Choose a month between {snapshot.Value.Settings.StartMonth} and {snapshot.Value.Settings.EndMonth}.");
        }
        var closed = snapshot.Value.Book.ClosedMonths.ToHashSet();
        if (command.Change.Closed)
        {
            closed.Add(command.Month);
        }
        else
        {
            closed.Remove(command.Month);
        }
        var properties = new JsonObject { [FinanceKeys.ClosedMonths] = FinanceJson.WriteMonths(closed) };
        var written = await dispatcher.SendAsync<SetItemProperties, Item>(new SetItemProperties(command.ItemId, properties.ToJsonString()) { FinanceWrite = true }, cancellationToken).ConfigureAwait(false);
        return written.IsFailure
            ? Result.Failure<FinanceMonthResponse>(written.Error)
            : Result.Success(new FinanceMonthResponse(command.Month.ToString(), command.Change.Closed, closed.OrderBy(month => month).Select(month => month.ToString()).ToList()));
    }

    /// <inheritdoc />
    public async ValueTask<Result<PostScheduledResponse>> HandleAsync(PostScheduledTransactions command, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(command);
        var snapshot = await LockedSnapshotAsync(command.ItemId, cancellationToken).ConfigureAwait(false);
        if (snapshot.IsFailure)
        {
            return Result.Failure<PostScheduledResponse>(snapshot.Error);
        }
        var book = snapshot.Value.Book;
        if (!snapshot.Value.Settings.Covers(command.Month))
        {
            return FinanceErrors.Failure<PostScheduledResponse>("invalid_month", $"Choose a month between {snapshot.Value.Settings.StartMonth} and {snapshot.Value.Settings.EndMonth}.");
        }
        if (book.IsClosed(command.Month))
        {
            return FinanceErrors.Failure<PostScheduledResponse>("month_closed", $"{command.Month} is closed. Reopen it to post into it.");
        }
        var posted = new List<FinanceTransactionResponse>();
        var already = 0;
        var skipped = book.Lines.Count(line => line.Scheduled && (line.Archived || book.Plan(line, command.Month) <= 0));
        foreach (var line in FinanceReportHandler.ScheduledLines(book, command.Month))
        {
            if (FinanceReportHandler.IsPosted(book, line, command.Month))
            {
                already++;
                continue;
            }
            if (book.Transactions.Count + posted.Count >= FinanceLoader.MaximumTransactions)
            {
                return FinanceErrors.Failure<PostScheduledResponse>("limit", $"A finance root holds at most {FinanceLoader.MaximumTransactions:N0} transactions.");
            }
            var plan = book.Plan(line, command.Month);
            var transaction = new FinanceTransaction(Guid.NewGuid(), line.Name, command.Month.Day(line.DueDay ?? 1), line.IsIncome ? plan : -plan, line.AccountId, line.Id, FinanceSources.Scheduled, command.Month, null, false);
            var created = await CreateAsync(snapshot.Value, transaction, cancellationToken).ConfigureAwait(false);
            if (created.IsFailure)
            {
                return Result.Failure<PostScheduledResponse>(created.Error);
            }
            posted.Add(created.Value.ToResponse());
        }
        return Result.Success(new PostScheduledResponse(command.Month.ToString(), posted, already, skipped));
    }

    /// <inheritdoc />
    public async ValueTask<Result<FinanceImportResponse>> HandleAsync(ImportFinanceStatement command, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(command);
        ArgumentNullException.ThrowIfNull(command.Import);
        var request = command.Import;
        if (string.IsNullOrWhiteSpace(request.Csv))
        {
            return FinanceErrors.Failure<FinanceImportResponse>("invalid_import", "The statement is empty.");
        }
        var snapshot = await LockedSnapshotAsync(command.ItemId, cancellationToken).ConfigureAwait(false);
        if (snapshot.IsFailure)
        {
            return Result.Failure<FinanceImportResponse>(snapshot.Error);
        }
        var book = snapshot.Value.Book;
        if (!book.AccountsById.TryGetValue(request.AccountId, out var account) || account.IsLoan)
        {
            return FinanceErrors.Failure<FinanceImportResponse>("account_not_found", "A statement is imported into one of this root's cash or card accounts.");
        }
        var parsed = CsvStatements.Parse(request.Csv);
        if (parsed.Problem is not null)
        {
            return FinanceErrors.Failure<FinanceImportResponse>("invalid_import", parsed.Problem);
        }
        var known = book.Transactions.Where(transaction => transaction.ImportKey is not null).Select(transaction => transaction.ImportKey!).ToHashSet(StringComparer.Ordinal);
        var lineByDescription = book.Transactions
            .Where(transaction => transaction.AccountId == account.Id && transaction.LineId is not null)
            .OrderByDescending(transaction => transaction.Date)
            .GroupBy(transaction => CsvStatements.Normalise(transaction.Description), StringComparer.Ordinal)
            .ToDictionary(group => group.Key, group => group.First().LineId!.Value, StringComparer.Ordinal);
        var unmatchedManual = book.Transactions
            .Where(transaction => transaction.AccountId == account.Id && transaction.ImportKey is null)
            .GroupBy(transaction => (transaction.Date, transaction.Amount))
            .ToDictionary(group => group.Key, group => new Queue<FinanceTransaction>(group));
        var rows = new List<FinanceImportRowResponse>();
        int created = 0, duplicates = 0, matched = 0, unreadable = 0;
        foreach (var row in parsed.Rows)
        {
            if (!row.IsReadable)
            {
                unreadable++;
                Add(rows, new FinanceImportRowResponse(row.Row, row.Date, row.Amount, row.Description, "unreadable", null, row.Problem, null));
                continue;
            }
            var date = row.Date!.Value;
            var amount = row.Amount!.Value;
            var key = CsvStatements.ImportKey(account.Id, date, amount, row.Description);
            if (book.IsClosed(YearMonth.Of(date)))
            {
                unreadable++;
                Add(rows, new FinanceImportRowResponse(row.Row, date, amount, row.Description, "unreadable", null, $"{YearMonth.Of(date)} is closed.", null));
                continue;
            }
            if (known.Contains(key))
            {
                duplicates++;
                Add(rows, new FinanceImportRowResponse(row.Row, date, amount, row.Description, "duplicate", null, null, null));
                continue;
            }
            if (unmatchedManual.TryGetValue((date, amount), out var candidates) && candidates.Count > 0)
            {
                var manual = candidates.Dequeue();
                known.Add(key);
                matched++;
                if (request.Commit)
                {
                    var claimed = await dispatcher.SendAsync<SetItemProperties, Item>(
                        new SetItemProperties(ItemId.From(manual.Id), new JsonObject { [FinanceKeys.ImportKey] = key, [FinanceKeys.Cleared] = true }.ToJsonString()) { FinanceWrite = true }, cancellationToken).ConfigureAwait(false);
                    if (claimed.IsFailure)
                    {
                        return Result.Failure<FinanceImportResponse>(claimed.Error);
                    }
                }
                Add(rows, new FinanceImportRowResponse(row.Row, date, amount, row.Description, "matched", manual.LineId, null, manual.Id));
                continue;
            }
            lineByDescription.TryGetValue(CsvStatements.Normalise(row.Description), out var suggested);
            var transactionToImport = new FinanceTransaction(Guid.NewGuid(), row.Description, date, amount, account.Id, suggested == Guid.Empty ? null : suggested, FinanceSources.Import, null, key, true);
            if (Refuse(transactionToImport, book) is { } invalid)
            {
                unreadable++;
                Add(rows, new FinanceImportRowResponse(row.Row, date, amount, row.Description, "unreadable", null, invalid.Error.Message, null));
                continue;
            }
            known.Add(key);
            Guid? transactionId = null;
            if (request.Commit)
            {
                if (book.Transactions.Count + created >= FinanceLoader.MaximumTransactions)
                {
                    return FinanceErrors.Failure<FinanceImportResponse>("limit", $"A finance root holds at most {FinanceLoader.MaximumTransactions:N0} transactions.");
                }
                var written = await CreateAsync(snapshot.Value, transactionToImport, cancellationToken).ConfigureAwait(false);
                if (written.IsFailure)
                {
                    return Result.Failure<FinanceImportResponse>(written.Error);
                }
                transactionId = written.Value.Id;
            }
            created++;
            Add(rows, new FinanceImportRowResponse(row.Row, date, amount, row.Description, "new", suggested == Guid.Empty ? null : suggested, null, transactionId));
        }
        return Result.Success(new FinanceImportResponse(parsed.Rows.Count, parsed.Readable, created, duplicates, matched, unreadable, request.Commit, rows, null));
    }

    private static void Add(List<FinanceImportRowResponse> rows, FinanceImportRowResponse row)
    {
        if (rows.Count < MaximumPreviewRows)
        {
            rows.Add(row);
        }
    }

    private static Result<FinanceTransactionResponse>? Refuse(FinanceTransaction transaction, FinanceBook book)
    {
        if (transaction.Validate() is { } invalid)
        {
            return FinanceErrors.Failure<FinanceTransactionResponse>("invalid_transaction", invalid);
        }
        if (!book.AccountsById.TryGetValue(transaction.AccountId, out var account) || account.IsLoan)
        {
            return FinanceErrors.Failure<FinanceTransactionResponse>("invalid_transaction", "A transaction moves on one of this root's cash or card accounts.");
        }
        if (transaction.LineId is { } lineId
            && (!book.LinesById.TryGetValue(lineId, out var line) || line.AccountId != transaction.AccountId))
        {
            return FinanceErrors.Failure<FinanceTransactionResponse>("invalid_transaction", "A transaction counts against a budget line assigned to the same account, or none.");
        }
        if (book.IsClosed(transaction.Month))
        {
            return FinanceErrors.Failure<FinanceTransactionResponse>("month_closed", $"{transaction.Month} is closed. Reopen it to record into it.");
        }
        return null;
    }

    private async ValueTask<Result<FinanceTransaction>> CreateAsync(FinanceSnapshot snapshot, FinanceTransaction transaction, CancellationToken cancellationToken)
    {
        var created = await dispatcher.SendAsync<CreateItem, Item>(
            new CreateItem(snapshot.Root.WorkspaceId, FinanceSetupHandler.RecordType, transaction.Description, ItemId.From(snapshot.Containers.Transactions), transaction.ToProperties()) { FinanceWrite = true },
            cancellationToken).ConfigureAwait(false);
        return created.IsFailure ? Result.Failure<FinanceTransaction>(created.Error) : Result.Success(transaction with { Id = created.Value.Id.Value });
    }

    private async ValueTask<Result<FinanceSnapshot>> LockedSnapshotAsync(ItemId itemId, CancellationToken cancellationToken)
    {
        var root = await loader.RootAsync(itemId, true, cancellationToken).ConfigureAwait(false);
        if (root.IsFailure)
        {
            return Result.Failure<FinanceSnapshot>(root.Error);
        }
        await financeLock.AcquireWorkspaceTopologyAsync(root.Value.WorkspaceId, cancellationToken).ConfigureAwait(false);
        root = await loader.RootAsync(itemId, true, cancellationToken).ConfigureAwait(false);
        if (root.IsFailure)
        {
            return Result.Failure<FinanceSnapshot>(root.Error);
        }
        await financeLock.AcquireAsync(itemId, cancellationToken).ConfigureAwait(false);
        root = await loader.RootAsync(itemId, true, cancellationToken).ConfigureAwait(false);
        return root.IsFailure ? Result.Failure<FinanceSnapshot>(root.Error) : await loader.LoadAsync(root.Value, cancellationToken).ConfigureAwait(false);
    }
}
