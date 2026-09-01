using System.Text.Json;
using System.Text.Json.Serialization;
using Nix.Features.Operations;

namespace Nix.Features.TemplateImports;

public sealed record BeginTemplateArchiveImportRequest(
    Guid WorkspaceId,
    string FileName,
    string MediaType,
    long ByteLength,
    string IdempotencyKey);

internal sealed record BeginManagedTemplateArchiveImportRequest(
    string FileName,
    string MediaType,
    long ByteLength,
    string ManagedSource,
    string IdempotencyKey);

public sealed record TemplateImportUploadResponse(
    Guid Id,
    string Status,
    Uri? UploadUrl,
    DateTimeOffset? CapabilityExpiresAt,
    DateTimeOffset ExpiresAt);

public sealed record TemplateImportProfileResponse(
    string Kind,
    int Version,
    string Key,
    string Name,
    string Description,
    bool IncludeBody,
    bool IncludeChildren);

public sealed record TemplateImportPreviewResponse(
    TemplateImportProfileResponse Profile,
    string Digest,
    string RootItemType,
    int ItemCount,
    int BodyCount,
    int ViewCount);

public sealed record TemplateImportResultResponse(
    Guid? OperationId,
    Guid TemplateId,
    string StableKey,
    string Digest,
    bool Unchanged,
    IReadOnlyList<Guid> WrittenTargetItemIds);

public sealed record TemplateImportResponse(
    Guid Id,
    Guid WorkspaceId,
    string Status,
    Guid? PreviewOperationId,
    Guid? CommitOperationId,
    TemplateImportPreviewResponse? Preview,
    TemplateImportResultResponse? Result,
    string? FailureCode,
    DateTimeOffset ExpiresAt,
    DateTimeOffset? CompletedAt);

public sealed record CommitTemplateImportRequest(string ExpectedDigest);

public sealed record TemplateImportJobPayload(Guid ImportId);

internal sealed record WorkerTemplateImportPreviewResponse(
    Guid ImportId,
    Guid WorkspaceId,
    string Origin,
    string? ManagedSource,
    string IdempotencyKey,
    string FileName,
    string DeclaredMediaType,
    long DeclaredByteLength,
    Uri SourceUrl,
    Uri SourceDeleteUrl,
    Uri PlanUploadUrl,
    Uri PlanDeleteUrl,
    DateTimeOffset CapabilityExpiresAt);

internal sealed record WorkerTemplateImportCommitResponse(
    Guid ImportId,
    Guid WorkspaceId,
    string Origin,
    string? ManagedSource,
    string IdempotencyKey,
    string FileName,
    string DeclaredMediaType,
    long DeclaredByteLength,
    string PlanSha256,
    long PlanByteLength,
    string SourceSha256,
    Uri? SourceUrl,
    Uri? SourceDeleteUrl,
    Uri? PlanUrl,
    Uri? PlanUploadUrl,
    Uri? PlanDeleteUrl,
    DateTimeOffset? CapabilityExpiresAt,
    WorkerCompleteTemplateImportResponse? CompletedResult);

internal sealed record CompleteTemplateImportPreviewRequest(
    string PlanSha256,
    long PlanByteLength,
    string SourceSha256,
    TemplateImportProfileResponse Profile,
    string RootItemType,
    int ItemCount,
    int BodyCount,
    int ViewCount);

internal sealed record StageTemplateImportRequest(
    TemplateImportProfileResponse Profile,
    IReadOnlyList<StageTemplateImportItemRequest> Items);

internal sealed record StageTemplateImportItemRequest(
    Guid SourceId,
    Guid? ParentSourceId,
    string Seq,
    string Title,
    string ItemType,
    JsonElement? Properties,
    JsonElement? Schema,
    JsonElement? Views,
    bool HasBody);

internal sealed record TemplateImportItemMappingResponse(
    Guid SourceId,
    Guid TargetItemId,
    string ItemType);

internal sealed record TemplateImportStageResponse(
    Guid ImportId,
    Guid? OperationId,
    Guid TemplateId,
    string StableKey,
    string Digest,
    bool Unchanged,
    IReadOnlyList<TemplateImportItemMappingResponse> ItemMappings,
    IReadOnlyList<TemplateImportItemMappingResponse> BodyWrites);

internal sealed record TemplateImportBodyAuthorizationResponse(
    Guid TenantId,
    Guid PrincipalId,
    Guid WorkspaceId,
    Guid ImportId,
    Guid? OperationId,
    IReadOnlyList<TemplateImportBodyAuthorizationItemResponse> Items,
    bool CanWrite);

internal sealed record TemplateImportBodyAuthorizationItemResponse(
    Guid SourceId,
    Guid TargetItemId,
    string ItemType,
    bool BodyRequired);

internal sealed record CompleteTemplateImportRequest(IReadOnlyList<Guid> WrittenTargetItemIds);

internal sealed record WorkerCompleteTemplateImportResponse(
    Guid ImportId,
    Guid? OperationId,
    Guid TemplateId,
    string StableKey,
    string Digest,
    bool Unchanged,
    int ItemCount,
    int BodyCount,
    IReadOnlyList<Guid> WrittenTargetItemIds);

internal sealed record RejectTemplateImportRequest(string Code);

internal sealed record ManagedTemplateImportFinalizationRequest(
    IReadOnlyList<ManagedTemplateImportFinalizationEntryRequest> Imports,
    IReadOnlyList<string> ActiveStableKeys);

internal sealed record ManagedTemplateImportFinalizationEntryRequest(
    Guid ImportId,
    Guid? OperationId,
    Guid TemplateId,
    string StableKey,
    string Digest,
    IReadOnlyList<Guid> WrittenTargetItemIds);

internal sealed record ManagedTemplateImportFinalizationResponse(
    int Activated,
    int Unchanged,
    int Retired);

internal sealed record ManagedTemplateStageSweepResponse(int Removed, IReadOnlyList<Guid> ItemIds);

[JsonSourceGenerationOptions(PropertyNamingPolicy = JsonKnownNamingPolicy.CamelCase)]
[JsonSerializable(typeof(BeginTemplateArchiveImportRequest))]
[JsonSerializable(typeof(BeginManagedTemplateArchiveImportRequest))]
[JsonSerializable(typeof(TemplateImportUploadResponse))]
[JsonSerializable(typeof(TemplateImportProfileResponse))]
[JsonSerializable(typeof(TemplateImportPreviewResponse))]
[JsonSerializable(typeof(TemplateImportResultResponse))]
[JsonSerializable(typeof(TemplateImportResponse))]
[JsonSerializable(typeof(CommitTemplateImportRequest))]
[JsonSerializable(typeof(TemplateImportJobPayload))]
[JsonSerializable(typeof(WorkerTemplateImportPreviewResponse))]
[JsonSerializable(typeof(WorkerTemplateImportCommitResponse))]
[JsonSerializable(typeof(CompleteTemplateImportPreviewRequest))]
[JsonSerializable(typeof(StageTemplateImportRequest))]
[JsonSerializable(typeof(StageTemplateImportItemRequest))]
[JsonSerializable(typeof(TemplateImportItemMappingResponse))]
[JsonSerializable(typeof(TemplateImportStageResponse))]
[JsonSerializable(typeof(TemplateImportBodyAuthorizationResponse))]
[JsonSerializable(typeof(TemplateImportBodyAuthorizationItemResponse))]
[JsonSerializable(typeof(CompleteTemplateImportRequest))]
[JsonSerializable(typeof(WorkerCompleteTemplateImportResponse))]
[JsonSerializable(typeof(RejectTemplateImportRequest))]
[JsonSerializable(typeof(ManagedTemplateImportFinalizationRequest))]
[JsonSerializable(typeof(ManagedTemplateImportFinalizationEntryRequest))]
[JsonSerializable(typeof(ManagedTemplateImportFinalizationResponse))]
[JsonSerializable(typeof(ManagedTemplateStageSweepResponse))]
[JsonSerializable(typeof(IReadOnlyList<Guid>))]
[JsonSerializable(typeof(OperationResponse))]
internal sealed partial class TemplateImportsJsonContext : JsonSerializerContext;
