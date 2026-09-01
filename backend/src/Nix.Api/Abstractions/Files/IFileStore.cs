using Nix.Domain.Files;
using Nix.Domain.Items;
using Nix.Domain.Tenancy;

namespace Nix.Abstractions.Files;

public sealed record BeginFileUpload(
    WorkspaceId WorkspaceId,
    ItemId? ParentId,
    ItemId? TargetItemId,
    string FileName,
    string DeclaredMediaType,
    long DeclaredByteLength,
    string IdempotencyKey,
    string Purpose = FileUploadPurposes.File);

public static class FileUploadPurposes
{
    public const string File = "file";
    public const string DocumentImport = "document_import";
}

public sealed record CompleteFileUpload(
    FileUploadId UploadId,
    string DetectedMediaType,
    long ByteLength,
    string Sha256,
    bool Previewable,
    int? PixelWidth,
    int? PixelHeight);

public sealed record FileUploadRecord(Guid Id, Guid WorkspaceId, string Purpose, string Status, string ObjectKey, DateTimeOffset ExpiresAt, Guid? ItemId, string? FailureCode);
public sealed record FileUploadInspectionRecord(Guid Id, Guid WorkspaceId, string Purpose, string Status, string ObjectKey, string FileName, string DeclaredMediaType, long DeclaredByteLength, DateTimeOffset ExpiresAt, Guid? ItemId);
public sealed record FileVersionRecord(Guid Id, int Version, string FileName, string MediaType, long ByteLength, string Sha256, bool Previewable, int? PixelWidth, int? PixelHeight, DateTimeOffset CreatedAt, bool Current);
public sealed record FileRecord(Guid ItemId, Guid WorkspaceId, FileVersionRecord Current, IReadOnlyList<FileVersionRecord> Versions);
public sealed record FileDownloadRecord(string ObjectKey, string FileName, string MediaType, long ByteLength, string Sha256, bool Previewable);

public interface IFileStore
{
    public ValueTask<FileUploadRecord?> BeginAsync(BeginFileUpload request, CancellationToken cancellationToken);
    public ValueTask<FileUploadRecord?> QueueInspectionAsync(FileUploadId id, CancellationToken cancellationToken);
    public ValueTask<FileUploadInspectionRecord?> GetInspectionAsync(FileUploadId id, CancellationToken cancellationToken);
    public ValueTask<FileRecord?> CompleteAsync(CompleteFileUpload request, CancellationToken cancellationToken);
    public ValueTask<bool> RejectAsync(FileUploadId id, string failureCode, CancellationToken cancellationToken);
    public ValueTask<FileUploadRecord?> GetUploadAsync(FileUploadId id, CancellationToken cancellationToken);
    public ValueTask<bool> CancelAsync(FileUploadId id, CancellationToken cancellationToken);
    public ValueTask<FileRecord?> GetAsync(ItemId itemId, CancellationToken cancellationToken);
    public ValueTask<FileDownloadRecord?> AuthorizeDownloadAsync(ItemId itemId, FileVersionId? versionId, CancellationToken cancellationToken);
}
