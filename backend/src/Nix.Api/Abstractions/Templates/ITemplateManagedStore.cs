using Nix.Domain.Primitives;
using Nix.Domain.Templates;
using Nix.Domain.Tenancy;

namespace Nix.Abstractions.Templates;

/// <summary>Runs managed-catalog finalization and bounded stage cleanup.</summary>
public interface ITemplateManagedStore
{
    public ValueTask<Result<ManagedTemplateBatchResult>> FinalizeManagedBatchAsync(
        WorkspaceId workspaceId,
        IReadOnlyList<ManagedTemplateFinalization> managedEntries,
        IReadOnlyList<string> activeStableKeys,
        CancellationToken cancellationToken);

    public ValueTask<Result<TemplateStageSweepResult>> SweepExpiredAsync(
        WorkspaceId workspaceId,
        CancellationToken cancellationToken);
}
