using Nix.Abstractions;
using Nix.Domain.Finance;
using Nix.Domain.Items;
using Nix.Domain.Primitives;
using Nix.Domain.Tenancy;
using Nix.Features.Items;

namespace Nix.Features.Finance;

/// <summary>A finance root and everything under it, read once for a request.</summary>
/// <param name="Problems">Children that claimed to be records but could not be read, by container and title.</param>
public sealed record FinanceSnapshot(Item Root, FinanceSettings Settings, FinanceContainers Containers, FinanceBook Book, IReadOnlyList<string> Problems);

/// <summary>Finds a finance root the caller may see, and reads its records into a <see cref="FinanceBook"/>.</summary>
/// <remarks>
/// Shares the item tree's authorization: the workspace is checked once, and every child read
/// after that runs under the same row-level security the item endpoints do. Malformed records
/// are listed in <see cref="FinanceSnapshot.Problems"/> and left out of the figures, so a broken
/// row can be found and fixed rather than being silently counted or silently hidden.
/// </remarks>
public sealed class FinanceLoader(IItemTree tree, IPermissionResolver permissions, IItemLocks locks)
{
    public const int MaximumAccounts = 200;
    public const int MaximumLines = 500;
    public const int MaximumTransactions = 20_000;
    private const int PageSize = 200;

    public static NixError NotFound() => ItemErrors.NotFound("No such finance root is visible and accessible.");

    /// <summary>The root item, or not found when it is missing or the caller may not read or write it.</summary>
    public async ValueTask<Result<Item>> RootAsync(ItemId itemId, bool write, CancellationToken cancellationToken)
    {
        var item = await tree.FindAsync(itemId, cancellationToken).ConfigureAwait(false);
        if (item is null)
        {
            return Result.Failure<Item>(NotFound());
        }
        var allowed = write
            ? await permissions.CanWriteWorkspaceAsync(item.WorkspaceId, cancellationToken).ConfigureAwait(false)
            : await permissions.CanReadWorkspaceAsync(item.WorkspaceId, cancellationToken).ConfigureAwait(false);
        return allowed ? Result.Success(item) : Result.Failure<Item>(NotFound());
    }

    /// <summary>Everything under a root the caller has already been allowed to see.</summary>
    public async ValueTask<Result<FinanceSnapshot>> LoadAsync(Item root, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(root);
        var bag = FinanceJson.Bag(root.Properties);
        var settings = FinanceSettings.Read(bag);
        if (settings is null)
        {
            return FinanceErrors.Failure<FinanceSnapshot>(
                FinanceSettings.IsConfigured(root.Properties) ? "invalid_settings" : "not_configured",
                "This item has no valid finance settings. Set them up first.");
        }
        var containers = FinanceContainers.Read(bag);
        if (containers is null)
        {
            return FinanceErrors.Failure<FinanceSnapshot>("not_configured", "This finance root has lost its containers. Set it up again.");
        }
        var ownedContainers = await ValidateContainersAsync(root, containers, cancellationToken).ConfigureAwait(false);
        if (ownedContainers.IsFailure)
        {
            return Result.Failure<FinanceSnapshot>(ownedContainers.Error);
        }
        var problems = new List<string>();
        var accountItems = await ChildrenAsync(root.WorkspaceId, ItemId.From(containers.Accounts), MaximumAccounts, "accounts", cancellationToken).ConfigureAwait(false);
        if (accountItems.IsFailure)
        {
            return Result.Failure<FinanceSnapshot>(accountItems.Error);
        }
        var lineItems = await ChildrenAsync(root.WorkspaceId, ItemId.From(containers.Lines), MaximumLines, "budget lines", cancellationToken).ConfigureAwait(false);
        if (lineItems.IsFailure)
        {
            return Result.Failure<FinanceSnapshot>(lineItems.Error);
        }
        var transactionItems = await ChildrenAsync(root.WorkspaceId, ItemId.From(containers.Transactions), MaximumTransactions, "transactions", cancellationToken).ConfigureAwait(false);
        if (transactionItems.IsFailure)
        {
            return Result.Failure<FinanceSnapshot>(transactionItems.Error);
        }

        var accounts = new List<FinanceAccount>();
        foreach (var item in accountItems.Value)
        {
            var account = FinanceAccount.Read(item.Id.Value, ItemProperties.ReadTitle(item.Properties), item.Properties);
            if (account is not null)
            {
                accounts.Add(account);
            }
            else if (FinanceAccount.Claims(item.Properties))
            {
                problems.Add($"Account '{ItemProperties.ReadTitle(item.Properties)}' ({item.Id.Value:D}) could not be read.");
            }
        }
        var accountsById = accounts.ToDictionary(account => account.Id);
        foreach (var account in accounts.ToArray())
        {
            if (account.SettlesFrom is { } settlesFrom
                && (!accountsById.TryGetValue(settlesFrom, out var source) || source.IsCreditCard || source.IsLoan))
            {
                accounts.Remove(account);
                problems.Add($"Account '{account.Name}' ({account.Id:D}) names a settlement account outside this finance root or with an unsupported type.");
            }
        }
        accountsById = accounts.ToDictionary(account => account.Id);
        var lines = new List<BudgetLine>();
        foreach (var item in lineItems.Value)
        {
            var line = BudgetLine.Read(item.Id.Value, ItemProperties.ReadTitle(item.Properties), item.Seq, item.Properties);
            if (line is not null)
            {
                lines.Add(line);
            }
            else if (BudgetLine.Claims(item.Properties))
            {
                problems.Add($"Budget line '{ItemProperties.ReadTitle(item.Properties)}' ({item.Id.Value:D}) could not be read.");
            }
        }
        foreach (var line in lines.ToArray())
        {
            if (!accountsById.TryGetValue(line.AccountId, out var account) || account.IsLoan || (line.IsIncome && account.IsCreditCard)
                || (line.LoanAccount is { } loanId && (!accountsById.TryGetValue(loanId, out var loan) || !loan.IsLoan)))
            {
                lines.Remove(line);
                problems.Add($"Budget line '{line.Name}' ({line.Id:D}) names an account outside this finance root or with an unsupported type.");
            }
        }
        var linesById = lines.ToDictionary(line => line.Id);
        var transactions = new List<FinanceTransaction>();
        foreach (var item in transactionItems.Value)
        {
            var transaction = FinanceTransaction.Read(item.Id.Value, ItemProperties.ReadTitle(item.Properties), item.Properties);
            if (transaction is not null
                && accountsById.TryGetValue(transaction.AccountId, out var account)
                && !account.IsLoan
                && (transaction.LineId is not { } lineId
                    || (linesById.TryGetValue(lineId, out var line) && line.AccountId == transaction.AccountId)))
            {
                transactions.Add(transaction);
            }
            else if (FinanceTransaction.Claims(item.Properties))
            {
                problems.Add($"Transaction '{ItemProperties.ReadTitle(item.Properties)}' ({item.Id.Value:D}) could not be read or names an account or line outside this finance root.");
            }
        }
        var closed = bag.ContainsKey(FinanceKeys.ClosedMonths)
            ? FinanceJson.Months(bag, FinanceKeys.ClosedMonths)
            : null;
        if (closed is null)
        {
            return FinanceErrors.Failure<FinanceSnapshot>("invalid_closed_months", "The list of closed months is damaged. Correct it before reading or changing this finance root.");
        }
        var book = new FinanceBook(settings, accounts, lines, transactions, closed);
        return Result.Success(new FinanceSnapshot(root, settings, containers, book, problems));
    }

    private async ValueTask<Result<bool>> ValidateContainersAsync(Item root, FinanceContainers containers, CancellationToken cancellationToken)
    {
        var ids = new[] { containers.Accounts, containers.Lines, containers.Transactions };
        if (ids.Distinct().Count() != ids.Length)
        {
            return FinanceErrors.Failure<bool>("not_configured", "This finance root has invalid containers. Set it up again.");
        }
        foreach (var id in ids)
        {
            var container = await tree.FindAsync(ItemId.From(id), cancellationToken).ConfigureAwait(false);
            if (container is null || container.WorkspaceId != root.WorkspaceId || container.ParentId != root.Id)
            {
                return FinanceErrors.Failure<bool>("not_configured", "This finance root has lost its containers. Set them up again.");
            }
        }
        return Result.Success(true);
    }

    /// <summary>The active children of a container, or a refusal once there are more than the ceiling.</summary>
    public async ValueTask<Result<IReadOnlyList<Item>>> ChildrenAsync(WorkspaceId workspaceId, ItemId parent, int ceiling, string what, CancellationToken cancellationToken)
    {
        // A lock covers everything under it, a finance root's accounts and transactions included.
        if (!await locks.MayReadBodyAsync(parent, cancellationToken).ConfigureAwait(false))
        {
            return Result.Failure<IReadOnlyList<Item>>(new NixError("items.locked", $"Item {parent} is locked. Unlock it to see its figures."));
        }

        var children = new List<Item>();
        long? after = null;
        while (true)
        {
            var page = await tree.ListChildrenAsync(workspaceId, parent, false, after, PageSize, cancellationToken).ConfigureAwait(false);
            children.AddRange(page);
            if (children.Count > ceiling)
            {
                return FinanceErrors.Failure<IReadOnlyList<Item>>("limit", $"This version supports at most {ceiling:N0} {what} per finance root. Its figures cannot be calculated safely.");
            }
            if (page.Count < PageSize)
            {
                return Result.Success<IReadOnlyList<Item>>(children);
            }
            after = page[^1].Seq;
        }
    }
}

/// <summary>Why a finance request was refused, prefixed so a client can tell the family apart.</summary>
public static class FinanceErrors
{
    public static Result<T> Failure<T>(string code, string message) => Result.Failure<T>(new NixError($"finance.{code}", message));

    public static Result<T> NotFound<T>() => Result.Failure<T>(FinanceLoader.NotFound());
}
