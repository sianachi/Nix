using Nix.Domain.Files;
using Nix.Domain.Importing;
using Nix.Domain.Items;
using Nix.Domain.Tenancy;
using Nix.Domain.Workers;

namespace Nix.Abstractions.Importing;

public sealed record BeginDocumentImport(
    WorkspaceId WorkspaceId,
    ItemId? ParentId,
    FileUploadId UploadId,
    string Format,
    string Title,
    string IdempotencyKey);

public sealed record CompleteDocumentImportPreview(
    DocumentImportId ImportId,
    string PlanSha256,
    long PlanByteLength,
    string SourceSha256,
    int ItemCount,
    int AssetCount,
    string Loss,
    string Omissions);

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
    string Format,
    string Title,
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
    IReadOnlyList<string> ObjectKeys);

public interface IDocumentImportStore
{
    public ValueTask<DocumentImportRecord?> BeginAsync(BeginDocumentImport request, CancellationToken cancellationToken);
    public ValueTask<DocumentImportRecord?> GetAsync(DocumentImportId id, CancellationToken cancellationToken);
    public ValueTask<DocumentImportExecutionRecord?> GetExecutionAsync(DocumentImportId id, CancellationToken cancellationToken);
    public ValueTask<DocumentImportRecord?> AttachPreviewJobAsync(DocumentImportId id, WorkerJobId jobId, CancellationToken cancellationToken);
    public ValueTask<DocumentImportRecord?> CompletePreviewAsync(CompleteDocumentImportPreview request, CancellationToken cancellationToken);
    public ValueTask<DocumentImportRecord?> AttachCommitJobAsync(DocumentImportId id, WorkerJobId jobId, CancellationToken cancellationToken);
    public ValueTask<DocumentImportStageRecord?> StageAsync(StageDocumentImport request, CancellationToken cancellationToken);
    public ValueTask<DocumentImportObjectRecord?> AuthorizeObjectUploadAsync(DocumentImportId id, string sourceId, CancellationToken cancellationToken);
    public ValueTask<bool> MarkObjectReadyAsync(DocumentImportId id, string sourceId, long byteLength, string sha256, CancellationToken cancellationToken);
    public ValueTask<DocumentImportStageRecord?> AuthorizeBodyWritesAsync(DocumentImportId id, CancellationToken cancellationToken);
    public ValueTask<DocumentImportRecord?> FinalizeAsync(DocumentImportId id, CancellationToken cancellationToken);
    public ValueTask<DocumentImportCleanupRecord?> FailAsync(DocumentImportId id, string failureCode, CancellationToken cancellationToken);
    public ValueTask<DocumentImportCleanupRecord?> CancelAsync(DocumentImportId id, CancellationToken cancellationToken);
}
