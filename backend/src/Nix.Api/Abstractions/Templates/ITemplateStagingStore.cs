using Nix.Domain.Items;
using Nix.Domain.Primitives;
using Nix.Domain.Templates;
using Nix.Domain.Tenancy;

namespace Nix.Abstractions.Templates;

/// <summary>Coordinates capture and import provisioning stages.</summary>
public interface ITemplateStagingStore
{
    public ValueTask<Result<TemplateCapturePlan>> BeginCaptureAsync(
        WorkspaceId workspaceId,
        ItemId sourceItemId,
        string title,
        string? description,
        bool includeBody,
        bool includeChildren,
        string idempotencyKey,
        CancellationToken cancellationToken);

    public ValueTask<Result<TemplateImportPlan>> BeginImportAsync(
        WorkspaceId workspaceId,
        string idempotencyKey,
        TemplateImportDescriptor descriptor,
        IReadOnlyList<TemplateImportItem> items,
        CancellationToken cancellationToken);

    public ValueTask<Result<TemplateId>> FinalizeOperationAsync(
        TemplateOperationId operationId,
        IReadOnlyList<ItemId> writtenBodyItemIds,
        CancellationToken cancellationToken);

    public ValueTask<Result<bool>> AbortOperationAsync(
        TemplateOperationId operationId,
        CancellationToken cancellationToken);
}
