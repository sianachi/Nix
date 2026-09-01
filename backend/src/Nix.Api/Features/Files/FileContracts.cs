using System.Text.Json.Serialization;
using Nix.Abstractions.Files;
using Nix.Features.Operations;

namespace Nix.Features.Files;

public sealed record BeginFileUploadRequest(Guid WorkspaceId, Guid? ParentId, Guid? TargetItemId, string FileName, string MediaType, long ByteLength, string IdempotencyKey);
public sealed record CompleteFileUploadRequest(string DetectedMediaType, long ByteLength, string Sha256, bool Previewable, int? PixelWidth, int? PixelHeight);
public sealed record FileUploadResponse(Guid Id, Guid WorkspaceId, string Status, string ObjectKey, DateTimeOffset ExpiresAt, Guid? ItemId, string? FailureCode);
public sealed record FileDownloadResponse(string ObjectKey, string FileName, string MediaType, long ByteLength, string Sha256, bool Previewable);
public sealed record FileUploadCapabilityResponse(Guid Id, string Status, Uri? UploadUrl, DateTimeOffset? CapabilityExpiresAt, DateTimeOffset ExpiresAt, Guid? ItemId, string? FailureCode);
public sealed record FileUploadStatusResponse(Guid Id, string Status, DateTimeOffset ExpiresAt, Guid? ItemId, string? FailureCode);
public sealed record FileDownloadCapabilityResponse(Uri Url, DateTimeOffset ExpiresAt, string FileName, string MediaType, long ByteLength, string Sha256, bool Inline, bool Unscanned, bool NoSniff);
public sealed record WorkerFileInspectionResponse(
    Guid UploadId,
    Guid WorkspaceId,
    string Status,
    string FileName,
    string DeclaredMediaType,
    long DeclaredByteLength,
    DateTimeOffset ExpiresAt,
    Uri SourceUrl,
    Uri SourceDeleteUrl,
    Uri DestinationUrl,
    Uri DestinationUploadUrl,
    Uri DestinationDeleteUrl,
    DateTimeOffset CapabilityExpiresAt,
    Guid? ItemId);
public sealed record RejectFileUploadRequest(string Code);
public sealed record FileInspectPayload(Guid UploadId);

[JsonSourceGenerationOptions(PropertyNamingPolicy = JsonKnownNamingPolicy.CamelCase)]
[JsonSerializable(typeof(BeginFileUploadRequest))]
[JsonSerializable(typeof(CompleteFileUploadRequest))]
[JsonSerializable(typeof(FileUploadResponse))]
[JsonSerializable(typeof(FileRecord))]
[JsonSerializable(typeof(FileVersionRecord))]
[JsonSerializable(typeof(IReadOnlyList<FileVersionRecord>))]
[JsonSerializable(typeof(FileDownloadResponse))]
[JsonSerializable(typeof(FileUploadCapabilityResponse))]
[JsonSerializable(typeof(FileUploadStatusResponse))]
[JsonSerializable(typeof(FileDownloadCapabilityResponse))]
[JsonSerializable(typeof(WorkerFileInspectionResponse))]
[JsonSerializable(typeof(RejectFileUploadRequest))]
[JsonSerializable(typeof(FileInspectPayload))]
[JsonSerializable(typeof(OperationResponse))]
internal sealed partial class FilesJsonContext : JsonSerializerContext;
