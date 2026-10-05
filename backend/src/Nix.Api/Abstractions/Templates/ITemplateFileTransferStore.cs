using Nix.Domain.Primitives;
using Nix.Domain.Templates;
using Nix.Domain.Tenancy;

namespace Nix.Abstractions.Templates;

/// <summary>Stages and lease-fences file copies owned by template lifecycle operations.</summary>
public interface ITemplateFileTransferStore
{
    public ValueTask<Result<IReadOnlyList<TemplateFileTransfer>>> PrepareTemplateFilesAsync(
        TemplateOperationId operationId,
        IReadOnlyList<TemplateOperationItem> mappings,
        CancellationToken cancellationToken);

    public ValueTask<Result<IReadOnlyList<TemplateFileTransfer>>> PrepareApplicationFilesAsync(
        TemplateApplicationId applicationId,
        IReadOnlyList<TemplateApplicationItem> mappings,
        CancellationToken cancellationToken);

    public ValueTask<TemplateFileTransferPage?> AuthorizeCopyAsync(
        string ownerKind,
        Guid ownerId,
        string executionId,
        Guid? afterTransferId,
        int limit,
        CancellationToken cancellationToken);

    public ValueTask<bool> CompleteCopyAsync(
        string ownerKind,
        Guid ownerId,
        string executionId,
        IReadOnlyList<Guid> transferIds,
        CancellationToken cancellationToken);

    public ValueTask<bool> HasUnreadyCopiesAsync(
        string ownerKind,
        Guid ownerId,
        CancellationToken cancellationToken);

    public ValueTask<WorkspaceId?> GetCopyWorkspaceAsync(
        string ownerKind,
        Guid ownerId,
        CancellationToken cancellationToken);
}
