using Nix.Domain.Items;
using Nix.Domain.Tenancy;

namespace Nix.Domain.Templates;

/// <summary>Counts and view vocabulary shown without materialising a template tree.</summary>
public sealed record TemplateShape(
    int FieldCount,
    int ViewCount,
    int ChildCount,
    IReadOnlyList<string> ViewKinds);

/// <summary>One catalog row plus its derived shape.</summary>
public sealed record TemplateCatalogSnapshot(WorkspaceTemplate Template, TemplateShape Shape, bool CanManage);

/// <summary>Catalog rows plus workspace capability, including when the catalog is empty.</summary>
public sealed record TemplateLibrarySnapshot(
    IReadOnlyList<TemplateCatalogSnapshot> Templates,
    bool CanManage);

/// <summary>One hidden item represented by its stable template identity.</summary>
public sealed record TemplateItemSnapshot(
    Guid SourceId,
    string ItemType,
    string Title,
    long Seq,
    string? Properties,
    string? Schema,
    string? Views,
    bool HasBody,
    IReadOnlyList<TemplateItemSnapshot> Children);

/// <summary>A complete catalog entry and its active hidden item tree.</summary>
public sealed record TemplateDetailSnapshot(
    WorkspaceTemplate Template,
    TemplateShape Shape,
    TemplateItemSnapshot Root,
    bool CanManage);

/// <summary>One source-to-target identity used to remap body references.</summary>
public sealed record TemplateItemMapping(
    Guid SourceId,
    ItemId ItemId,
    string ItemType);

/// <summary>One body Collab must copy.</summary>
public sealed record TemplateBodyCopy(
    ItemId SourceItemId,
    ItemId TargetItemId,
    string ItemType);

/// <summary>One archive body Collab must hydrate.</summary>
public sealed record TemplateBodyWrite(
    Guid SourceId,
    ItemId TargetItemId,
    string ItemType);

/// <summary>Result of beginning a capture.</summary>
public sealed record TemplateCapturePlan(
    TemplateOperationId OperationId,
    TemplateId TemplateId,
    IReadOnlyList<TemplateItemMapping> ItemMappings,
    IReadOnlyList<TemplateBodyCopy> BodyCopies);

/// <summary>One editable provisioning revision and the body copies needed to hydrate it.</summary>
public sealed record TemplateDraftPlan(
    TemplateOperationId OperationId,
    TemplateId TemplateId,
    string Title,
    string? Description,
    DateTimeOffset ExpiresAt,
    TemplateItemSnapshot Root,
    IReadOnlyList<TemplateItemMapping> ItemMappings,
    IReadOnlyList<TemplateBodyCopy> BodyCopies);

/// <summary>One staged or unchanged member of an atomic managed catalog update.</summary>
public sealed record ManagedTemplateFinalization(
    TemplateOperationId? OperationId,
    TemplateId TemplateId,
    string StableKey,
    string Digest,
    IReadOnlyList<ItemId> WrittenTargetItemIds);

/// <summary>Counts returned after an atomic managed catalog update.</summary>
public sealed record ManagedTemplateBatchResult(int Activated, int Unchanged, int Retired);

/// <summary>Expired provisioning envelopes removed with their cascading body rows.</summary>
public sealed record TemplateStageSweepResult(int Removed, IReadOnlyList<ItemId> ItemIds);

/// <summary>Cheap workspace admission returned before Media reads an archive.</summary>
public sealed record TemplateWorkspaceAuthorization(
    TenantId TenantId,
    Nix.Domain.Identity.PrincipalId PrincipalId,
    WorkspaceId WorkspaceId,
    bool CanWrite,
    bool CanManageTemplates);

/// <summary>Result of beginning a validated archive import.</summary>
public sealed record TemplateImportPlan(
    TemplateOperationId? OperationId,
    TemplateId TemplateId,
    bool Unchanged,
    IReadOnlyList<TemplateItemMapping> ItemMappings,
    IReadOnlyList<TemplateBodyWrite> BodyWrites);

/// <summary>Result of beginning or replaying an application.</summary>
public sealed record TemplateApplicationPlan(
    TemplateApplicationId ApplicationId,
    TemplateId TemplateId,
    ItemId TargetItemId,
    bool AlreadyApplied,
    IReadOnlyList<TemplateItemMapping> CreatedItems,
    IReadOnlyList<TemplateItemMapping> ItemMappings,
    IReadOnlyList<TemplateBodyCopy> BodyCopies);

/// <summary>Authorization context for a staging item body.</summary>
public sealed record TemplateOperationAuthorization(
    Guid OperationId,
    ItemId ItemId,
    TenantId TenantId,
    Nix.Domain.Identity.PrincipalId PrincipalId,
    WorkspaceId WorkspaceId,
    string ItemType,
    bool IsSource,
    bool IsTarget,
    bool CanWrite);

/// <summary>Authorization context for one active template item body.</summary>
public sealed record TemplateItemAuthorization(
    TemplateId TemplateId,
    Guid SourceId,
    ItemId ItemId,
    TenantId TenantId,
    Nix.Domain.Identity.PrincipalId PrincipalId,
    WorkspaceId WorkspaceId,
    string ItemType,
    bool CanRead,
    bool CanWrite);

/// <summary>Portable envelope plus internal row identity for Collab export.</summary>
public sealed record TemplateExportItem(
    Guid SourceId,
    Guid? ParentSourceId,
    ItemId ItemId,
    string ItemType,
    string Title,
    long Seq,
    string? Properties,
    string? Schema,
    string? Views,
    bool HasBody);

/// <summary>Caller-scoped snapshot used to assemble a template-profile archive.</summary>
public sealed record TemplateExportSnapshot(
    TemplateId TemplateId,
    WorkspaceId WorkspaceId,
    string StableKey,
    string Title,
    string? Description,
    TemplateOrigin Origin,
    int Revision,
    bool IncludeBody,
    bool IncludeChildren,
    IReadOnlyList<TemplateExportItem> Items);

/// <summary>Metadata attached to one validated template-profile import.</summary>
public sealed record TemplateImportDescriptor(
    string StableKey,
    string Title,
    string? Description,
    TemplateOrigin Origin,
    string? ManagedSource,
    string Digest,
    bool IncludeBody,
    bool IncludeChildren);

/// <summary>One parent-first item envelope accepted from the hostile-file validation boundary.</summary>
public sealed record TemplateImportItem(
    Guid SourceId,
    Guid? ParentSourceId,
    string ItemType,
    string Title,
    long Seq,
    string? Properties,
    string? Schema,
    string? Views,
    bool HasBody);

/// <summary>Server-owned additions and conflicts shown before applying a template.</summary>
public sealed record TemplatePreflight(
    TemplateId TemplateId,
    TemplateApplicationMode Mode,
    int FieldAdditions,
    int ViewAdditions,
    int ItemAdditions,
    IReadOnlyList<string> Conflicts,
    bool CanApply);
