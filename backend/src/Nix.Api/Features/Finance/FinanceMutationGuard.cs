using Nix.Abstractions;
using Nix.Domain.Finance;
using Nix.Domain.Items;
using Nix.Domain.Primitives;
using Nix.Domain.Tenancy;

namespace Nix.Features.Finance;

/// <summary>Protects closed finance roots from writes through ordinary item commands.</summary>
public sealed class FinanceMutationGuard(IItemTree tree, IFinanceLock financeLock) : IFinanceMutationGuard
{
    private const int FinanceCandidateLimit = 21_000;

    public async ValueTask<NixError?> CheckAsync(
        WorkspaceId workspaceId,
        ItemId itemId,
        ItemId? destinationParentId,
        bool includeSubtree,
        CancellationToken cancellationToken,
        bool allowOpenTransaction = false)
    {
        ArgumentNullException.ThrowIfNull(tree);
        ArgumentNullException.ThrowIfNull(financeLock);

        // A direct property write can race first-time setup on an ordinary item and then
        // overwrite the newly installed finance properties. Serialize all guarded writes with
        // root setup/close before discovering ancestry; structural operations also rely on this
        // lock to prevent a root moving into or out of the affected subtree after discovery.
        await financeLock.AcquireWorkspaceTopologyAsync(workspaceId, cancellationToken).ConfigureAwait(false);
        var first = await ReadCandidatesAsync(workspaceId, itemId, destinationParentId, includeSubtree, cancellationToken).ConfigureAwait(false);
        if (first.Count > FinanceCandidateLimit)
        {
            return ClosedError("This operation affects too many finance records to validate safely.");
        }
        var roots = first.Where(IsRoot).Select(item => item.Id).Distinct().OrderBy(id => id.Value).ToArray();
        foreach (var rootId in roots)
        {
            await financeLock.AcquireAsync(rootId, cancellationToken).ConfigureAwait(false);
        }

        var candidates = first;
        // All structural changes and finance writes take the topology lock first. It therefore
        // keeps this bounded candidate set stable through the generic write; the root locks above
        // also serialize this operation with root-scoped finance transactions.
        if (candidates.Any(item => !IsRoot(item) && IsFinanceRecord(item))
            && !candidates.Any(IsRoot))
        {
            return ClosedError("The finance record has no valid finance root; repair its structure before changing it.");
        }

        var lockedRoots = roots.ToHashSet();
        if (candidates.Where(IsRoot).Any(root => !lockedRoots.Contains(root.Id)))
        {
            // Advisory locks cannot be released and reacquired in sorted order within this
            // transaction. A newly appeared root means ancestry changed during discovery; refuse
            // so the caller can retry from a clean transaction with the complete lock set.
            return ClosedError("Finance ancestry changed while the operation was being checked. Retry it.");
        }

        var rootsInScope = candidates.Where(IsRoot).ToArray();
        var directOpenMonth = allowOpenTransaction
            ? DirectTransactionIsOpen(itemId, candidates, rootsInScope)
            : false;
        foreach (var root in rootsInScope)
        {
            var rootBag = FinanceJson.Bag(root.Properties);
            var closed = rootBag.ContainsKey(FinanceKeys.ClosedMonths)
                ? FinanceJson.Months(rootBag, FinanceKeys.ClosedMonths)
                : null;
            if (closed is null)
            {
                return ClosedError("The finance root has damaged closed-month metadata; repair it before changing related items.");
            }
            if (closed.Count > 0 && !directOpenMonth)
            {
                return ClosedError("Reopen every closed month before changing finance items or their ancestry.");
            }
        }

        return null;
    }

    private async ValueTask<IReadOnlyList<Item>> ReadCandidatesAsync(
        WorkspaceId workspaceId,
        ItemId itemId,
        ItemId? destinationParentId,
        bool includeSubtree,
        CancellationToken cancellationToken)
    {
        var candidates = new Dictionary<ItemId, Item>();
        Add(await tree.ListFinanceBoundaryItemsAsync(workspaceId, itemId, includeSubtree, FinanceCandidateLimit, cancellationToken).ConfigureAwait(false));
        if (destinationParentId is { } destination)
        {
            Add(await tree.ListFinanceBoundaryItemsAsync(workspaceId, destination, false, FinanceCandidateLimit, cancellationToken).ConfigureAwait(false));
        }
        return candidates.Values.ToArray();

        void Add(IReadOnlyList<Item> items)
        {
            foreach (var item in items)
            {
                candidates.TryAdd(item.Id, item);
            }
        }
    }

    private static bool IsRoot(Item item) => FinanceSettings.IsConfigured(item.Properties);

    private static bool IsFinanceRecord(Item item)
    {
        var bag = FinanceJson.Bag(item.Properties);
        return bag.ContainsKey(FinanceKeys.Kind);
    }

    private static bool DirectTransactionIsOpen(ItemId itemId, IReadOnlyList<Item> candidates, Item[] roots)
    {
        if (roots.Length != 1 || candidates.Any(item => !IsRoot(item) && item.Id != itemId && IsFinanceRecord(item)))
        {
            return false;
        }
        var target = candidates.FirstOrDefault(item => item.Id == itemId);
        if (target is null)
        {
            return false;
        }
        var bag = FinanceJson.Bag(target.Properties);
        if (FinanceJson.Text(bag, FinanceKeys.Kind) != FinanceKinds.Transaction
            || FinanceJson.Date(bag, FinanceKeys.Date) is not { } date)
        {
            return false;
        }
        var closed = FinanceJson.Months(FinanceJson.Bag(roots[0].Properties), FinanceKeys.ClosedMonths);
        return closed is { } months && !months.Contains(YearMonth.Of(date));
    }

    private static NixError ClosedError(string detail) => new("finance.month_closed", detail);
}
