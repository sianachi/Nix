using Nix.Domain.Files;
using Nix.Domain.Items;
using Nix.Domain.Tenancy;

namespace Nix.Domain.Importing;

/// <summary>One complete source-to-hidden-target mapping in an import publication plan.</summary>
public sealed class DocumentImportItem
{
    public required DocumentImportId ImportId { get; init; }
    public required TenantId TenantId { get; init; }
    public required string SourceId { get; init; }
    public string? ParentSourceId { get; init; }
    public required ItemId TargetItemId { get; init; }
    public required string ItemType { get; init; }
    public required string FinalLifecycleState { get; init; }
    public required bool BodyRequired { get; init; }
    public FileVersionId? FileVersionId { get; init; }
    public string? ObjectKey { get; init; }
    public required bool ObjectReady { get; set; }
}
