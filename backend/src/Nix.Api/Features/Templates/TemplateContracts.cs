using System.Text.Json.Nodes;
using System.Text.Json.Serialization;

namespace Nix.Features.Templates;

[JsonConverter(typeof(JsonStringEnumConverter<TemplateOriginResponse>))]
internal enum TemplateOriginResponse
{
    [JsonStringEnumMemberName("seed")]
    Seed,

    [JsonStringEnumMemberName("user")]
    User,

    [JsonStringEnumMemberName("managed")]
    Managed,
}

[JsonConverter(typeof(JsonStringEnumConverter<TemplateApplicationModeResponse>))]
internal enum TemplateApplicationModeResponse
{
    [JsonStringEnumMemberName("merge")]
    Merge,

    [JsonStringEnumMemberName("create")]
    Create,
}

internal sealed record TemplateCapabilitiesResponse(
    bool CanEdit,
    bool CanDelete,
    bool CanExport,
    bool CanApply);

internal sealed record TemplateLibraryCapabilitiesResponse(bool CanManage);

internal sealed record TemplateCatalogResponse(
    IReadOnlyList<TemplateSummaryResponse> Templates,
    TemplateLibraryCapabilitiesResponse Capabilities);

internal sealed record TemplateSummaryResponse(
    Guid Id,
    Guid WorkspaceId,
    string Title,
    string? Description,
    TemplateOriginResponse Origin,
    int Revision,
    bool IncludeBody,
    bool IncludeChildren,
    int FieldCount,
    int ViewCount,
    int ChildCount,
    IReadOnlyList<string> ViewKinds,
    TemplateCapabilitiesResponse Capabilities,
    DateTimeOffset UpdatedAt);

internal sealed record TemplateItemResponse(
    Guid SourceId,
    string ItemType,
    string Title,
    string Seq,
    JsonObject? Properties,
    TemplatePropertySchemaResponse? Schema,
    TemplateStoredViewsResponse? Views,
    bool HasBody,
    IReadOnlyList<TemplateItemResponse> Children);

internal sealed record TemplatePropertyDefinitionResponse(
    string Key,
    string Label,
    string Type,
    IReadOnlyList<string> Options,
    bool Required);

internal sealed record TemplatePropertySchemaResponse(
    IReadOnlyList<TemplatePropertyDefinitionResponse> Properties,
    IReadOnlyList<TemplatePropertyDefinitionResponse> Declared,
    bool Inherit);

internal sealed record TemplateFilterResponse(string Property, string Operator, string Value);

internal sealed record TemplateFormConditionResponse(
    string FieldBlockId,
    string Operator,
    string? Value);

internal sealed record TemplateFormBlockResponse(
    string Id,
    string Kind,
    string? PropertyKey,
    string Text,
    string? Help,
    bool Required,
    string? IdentityRole,
    IReadOnlyList<TemplateFormConditionResponse> VisibleWhen);

internal sealed record TemplateFormPageResponse(
    string Id,
    string Title,
    string? Description,
    IReadOnlyList<TemplateFormConditionResponse> VisibleWhen,
    IReadOnlyList<TemplateFormBlockResponse> Blocks);

internal sealed record TemplateInteractiveFormResponse(
    IReadOnlyList<TemplateFormPageResponse> Pages,
    string TitleMode,
    string? TitleFieldBlockId,
    string ConfirmationTitle,
    string ConfirmationMessage);

internal sealed record TemplateViewResponse(
    string Id,
    string Name,
    string Kind,
    IReadOnlyList<string> Columns,
    string? GroupBy,
    IReadOnlyList<string> GroupOrder,
    string? DateProperty,
    string? SortBy,
    bool SortDescending,
    string? Mode,
    string? CoverProperty,
    string? EndDateProperty,
    string? CardSize,
    IReadOnlyList<TemplateFilterResponse> Filters,
    string? CompanionViewId,
    string? CompanionPlacement,
    TemplateInteractiveFormResponse? InteractiveForm);

internal sealed record TemplateStoredViewsResponse(
    IReadOnlyList<TemplateViewResponse> Views,
    string? Default);

internal sealed record TemplateDetailResponse(
    Guid Id,
    Guid WorkspaceId,
    string Title,
    string? Description,
    TemplateOriginResponse Origin,
    int Revision,
    bool IncludeBody,
    bool IncludeChildren,
    int FieldCount,
    int ViewCount,
    int ChildCount,
    IReadOnlyList<string> ViewKinds,
    TemplateCapabilitiesResponse Capabilities,
    DateTimeOffset UpdatedAt,
    TemplateItemResponse Root);

internal sealed record UpdateTemplateItemRequest(
    string? Title,
    JsonObject? Properties,
    JsonObject? Schema,
    JsonObject? Views);

internal sealed record TemplatePreflightRequest(
    TemplateApplicationModeResponse Mode,
    Guid? TargetItemId,
    Guid? ParentItemId,
    string? Title);

internal sealed record TemplateAdditionsResponse(int Fields, int Views, int Items);

internal sealed record TemplatePreflightResponse(
    Guid TemplateId,
    TemplateApplicationModeResponse Mode,
    TemplateAdditionsResponse Additions,
    IReadOnlyList<string> Conflicts,
    bool CanApply);

internal sealed record BeginTemplateCaptureRequest(
    Guid WorkspaceId,
    Guid SourceItemId,
    string Title,
    string? Description,
    bool IncludeBody,
    bool IncludeChildren,
    string IdempotencyKey);

internal sealed record ImportTemplateDescriptorRequest(
    string StableKey,
    string Title,
    string? Description,
    string Origin,
    string? ManagedSource,
    string Digest,
    bool IncludeBody,
    bool IncludeChildren);

public sealed record ImportTemplateItemRequest(
    Guid SourceId,
    Guid? ParentSourceId,
    string ItemType,
    string Title,
    string Seq,
    JsonObject? Properties,
    JsonObject? Schema,
    JsonObject? Views,
    bool HasBody);

internal sealed record BeginTemplateImportRequest(
    Guid WorkspaceId,
    string IdempotencyKey,
    ImportTemplateDescriptorRequest Template,
    IReadOnlyList<ImportTemplateItemRequest> Items);

internal sealed record BeginTemplateApplicationRequest(
    Guid TemplateId,
    string Mode,
    Guid? TargetItemId,
    Guid? ParentItemId,
    string? Title,
    string IdempotencyKey);

internal sealed record FinalizeTemplateBodiesRequest(IReadOnlyList<Guid> WrittenTargetItemIds);

internal sealed record ItemMappingResponse(Guid SourceId, Guid ItemId, string ItemType);

internal sealed record BodyCopyResponse(Guid SourceItemId, Guid TargetItemId, string ItemType);

internal sealed record BodyWriteResponse(Guid SourceId, Guid TargetItemId, string ItemType);

internal sealed record BeginTemplateCaptureResponse(
    Guid OperationId,
    Guid TemplateId,
    IReadOnlyList<ItemMappingResponse> ItemMappings,
    IReadOnlyList<BodyCopyResponse> BodyCopies);

internal sealed record BeginTemplateImportResponse(
    Guid? OperationId,
    Guid TemplateId,
    bool Unchanged,
    IReadOnlyList<ItemMappingResponse> ItemMappings,
    IReadOnlyList<BodyWriteResponse> BodyWrites);

internal sealed record BeginTemplateApplicationResponse(
    Guid ApplicationId,
    Guid TemplateId,
    Guid TargetItemId,
    bool AlreadyApplied,
    IReadOnlyList<ItemMappingResponse> CreatedItems,
    IReadOnlyList<ItemMappingResponse> ItemMappings,
    IReadOnlyList<BodyCopyResponse> BodyCopies);

internal sealed record FinalizeTemplateResponse(Guid TemplateId);

internal sealed record FinalizeTemplateApplicationResponse(Guid TargetItemId);

internal sealed record BeginTemplateDraftRequest(string IdempotencyKey);

internal sealed record UpdateTemplateDraftRequest(string? Title, string? Description);

internal sealed record TemplateDraftResponse(
    Guid OperationId,
    Guid TemplateId,
    string Title,
    string? Description,
    DateTimeOffset ExpiresAt,
    TemplateItemResponse Root,
    IReadOnlyList<ItemMappingResponse> ItemMappings,
    IReadOnlyList<BodyCopyResponse> BodyCopies);

internal sealed record ManagedTemplateFinalizeEntryRequest(
    Guid? OperationId,
    Guid TemplateId,
    string StableKey,
    string Digest,
    IReadOnlyList<Guid> WrittenTargetItemIds);

internal sealed record FinalizeManagedTemplatesRequest(
    IReadOnlyList<ManagedTemplateFinalizeEntryRequest> Imports,
    IReadOnlyList<string> ActiveStableKeys);

internal sealed record FinalizeManagedTemplatesResponse(int Activated, int Unchanged, int Retired);

internal sealed record SweepExpiredTemplateStagesResponse(int Removed, IReadOnlyList<Guid> ItemIds);

internal sealed record TemplateImportAuthorizationResponse(
    Guid WorkspaceId,
    Guid TenantId,
    Guid PrincipalId,
    bool CanWrite,
    bool CanManageTemplates);

internal sealed record TemplateOperationAuthorizationResponse(
    Guid OperationId,
    Guid ItemId,
    Guid TenantId,
    Guid PrincipalId,
    Guid WorkspaceId,
    string ItemType,
    bool IsSource,
    bool IsTarget,
    bool CanWrite);

internal sealed record TemplateItemAuthorizationResponse(
    Guid TemplateId,
    Guid SourceId,
    Guid ItemId,
    Guid TenantId,
    Guid PrincipalId,
    Guid WorkspaceId,
    string ItemType,
    bool CanRead,
    bool CanWrite);

internal sealed record TemplateExportItemResponse(
    Guid SourceId,
    Guid? ParentSourceId,
    Guid ItemId,
    string ItemType,
    string Title,
    string Seq,
    JsonObject Properties,
    JsonObject? Schema,
    JsonObject? Views,
    bool HasBody);

internal sealed record TemplateExportResponse(
    Guid TemplateId,
    Guid WorkspaceId,
    string StableKey,
    string Title,
    string? Description,
    TemplateOriginResponse Origin,
    int Revision,
    bool IncludeBody,
    bool IncludeChildren,
    IReadOnlyList<TemplateExportItemResponse> Items);
