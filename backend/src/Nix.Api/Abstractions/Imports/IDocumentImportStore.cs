using Nix.Domain.Files;
using Nix.Domain.Importing;
using Nix.Domain.Items;
using Nix.Domain.Templates;
using Nix.Domain.Tenancy;
using Nix.Domain.Workers;

namespace Nix.Abstractions.Importing;

public sealed record BeginDocumentImport(
    WorkspaceId WorkspaceId,
    ItemId? ParentId,
    FileUploadId UploadId,
    string Format,
    string Title,
    string IdempotencyKey,
    string Purpose = DocumentImportPurposes.Workspace,
    string? ManagedSource = null);

public sealed record CompleteDocumentImportPreview(
    DocumentImportId ImportId,
    string PlanSha256,
    long PlanByteLength,
    string SourceSha256,
    int ItemCount,
    int AssetCount,
    string Loss,
    string Omissions,
    string? TemplatePreview = null);

public sealed record ImportFilePlan(
    string SourceKind,
    string? AssetPath,
    string FileName,
    string MediaType,
    long ByteLength,
    string Sha256,
    bool Previewable,
    int? PixelWidth,
    int? PixelHeight);

public sealed record ImportEnvelopePlan(
    string SourceId,
    string? ParentSourceId,
    int Order,
    string Title,
    string ItemType,
    string? Properties,
    string? Schema,
    string? Views,
    string FinalLifecycleState,
    bool BodyRequired,
    ImportFilePlan? File);

public sealed record StageDocumentImport(
    DocumentImportId ImportId,
    string PlanSha256,
    string SourceSha256,
    IReadOnlyList<ImportEnvelopePlan> Items);

public sealed record DocumentImportRecord(
    Guid Id,
    Guid WorkspaceId,
    Guid UploadId,
    Guid? ParentId,
    string Purpose,
    string? ManagedSource,
    string Format,
    string Title,
    string IdempotencyKey,
    string Status,
    Guid? PreviewJobId,
    Guid? CommitJobId,
    string PlanObjectKey,
    string? PlanSha256,
    long? PlanByteLength,
    string? SourceSha256,
    int? ItemCount,
    int? AssetCount,
    string? Loss,
    string? Omissions,
    string? TemplatePreview,
    Guid? TemplateOperationId,
    Guid? TemplateId,
    string? TemplateStableKey,
    string? TemplateDigest,
    bool? TemplateUnchanged,
    string? TemplateWrittenTargetItemIds,
    Guid? RootItemId,
    string? FailureCode,
    DateTimeOffset ExpiresAt,
    DateTimeOffset? CompletedAt);

public sealed record DocumentImportExecutionRecord(
    DocumentImportRecord Import,
    string SourceObjectKey,
    string SourceFileName,
    string SourceMediaType,
    long SourceByteLength);

public sealed record DocumentImportItemMapping(
    string SourceId,
    Guid TargetItemId,
    string ItemType,
    bool BodyRequired,
    string? ObjectKey,
    bool ObjectReady);

public sealed record DocumentImportStageRecord(
    Guid ImportId,
    Guid RootItemId,
    IReadOnlyList<DocumentImportItemMapping> Items);

public sealed record DocumentImportObjectRecord(
    string SourceId,
    string ObjectKey,
    string MediaType,
    long ByteLength,
    string Sha256,
    bool ObjectReady);

public sealed record DocumentImportCleanupRecord(
    Guid WorkspaceId,
    IReadOnlyList<string> ObjectKeys,
    Guid? TemplateOperationId = null);

public sealed record AttachTemplateImportStage(
    DocumentImportId ImportId,
    TemplateOperationId? OperationId,
    TemplateId TemplateId,
    string StableKey,
    string Digest,
    bool Unchanged);

public sealed record CompleteTemplateImport(
    DocumentImportId ImportId,
    IReadOnlyList<ItemId> WrittenTargetItemIds,
    bool Managed);

public interface IDocumentImportStore
{
    public ValueTask<DocumentImportRecord?> BeginAsync(BeginDocumentImport request, CancellationToken cancellationToken);
    public ValueTask<DocumentImportRecord?> GetAsync(DocumentImportId id, CancellationToken cancellationToken);
    public ValueTask<DocumentImportExecutionRecord?> GetExecutionAsync(DocumentImportId id, CancellationToken cancellationToken);
    public ValueTask<DocumentImportRecord?> AttachPreviewJobAsync(DocumentImportId id, WorkerJobId jobId, CancellationToken cancellationToken);
    public ValueTask<DocumentImportRecord?> CompletePreviewAsync(CompleteDocumentImportPreview request, CancellationToken cancellationToken);
    public ValueTask<DocumentImportRecord?> AttachCommitJobAsync(DocumentImportId id, WorkerJobId jobId, CancellationToken cancellationToken);
    public ValueTask<DocumentImportRecord?> AttachTemplateStageAsync(AttachTemplateImportStage request, CancellationToken cancellationToken);
    public ValueTask<DocumentImportRecord?> CompleteTemplateAsync(CompleteTemplateImport request, CancellationToken cancellationToken);
    public ValueTask<bool> CompleteManagedBatchAsync(IReadOnlyList<DocumentImportId> importIds, CancellationToken cancellationToken);
    public ValueTask<DocumentImportStageRecord?> StageAsync(StageDocumentImport request, CancellationToken cancellationToken);
    public ValueTask<DocumentImportObjectRecord?> AuthorizeObjectUploadAsync(DocumentImportId id, string sourceId, CancellationToken cancellationToken);
    public ValueTask<bool> MarkObjectReadyAsync(DocumentImportId id, string sourceId, long byteLength, string sha256, CancellationToken cancellationToken);
    public ValueTask<DocumentImportStageRecord?> AuthorizeBodyWritesAsync(DocumentImportId id, CancellationToken cancellationToken);
    public ValueTask<DocumentImportRecord?> FinalizeAsync(DocumentImportId id, CancellationToken cancellationToken);
    public ValueTask<DocumentImportCleanupRecord?> FailAsync(DocumentImportId id, string failureCode, CancellationToken cancellationToken);
    public ValueTask<DocumentImportCleanupRecord?> CancelAsync(DocumentImportId id, CancellationToken cancellationToken);
}
