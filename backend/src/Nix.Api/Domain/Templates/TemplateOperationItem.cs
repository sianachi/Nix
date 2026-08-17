using Nix.Domain.Items;
using Nix.Domain.Tenancy;

namespace Nix.Domain.Templates;

/// <summary>Complete source-to-staged mapping for a capture or import operation.</summary>
public sealed class TemplateOperationItem
{
    /// <summary>Gets the staging operation.</summary>
    public required TemplateOperationId OperationId { get; init; }

    /// <summary>Gets the tenant scope.</summary>
    public required TenantId TenantId { get; init; }

    /// <summary>Gets the stable source identity in the resulting template.</summary>
    public required Guid TemplateSourceId { get; init; }

    /// <summary>Gets the existing workspace source for capture, or null for archive import.</summary>
    public ItemId? SourceItemId { get; init; }

    /// <summary>Gets the hidden staged template item.</summary>
    public required ItemId TargetItemId { get; init; }

    /// <summary>Gets the body kind used by Collab.</summary>
    public required string ItemType { get; init; }

    /// <summary>Gets whether Collab must write this target body before finalization.</summary>
    public required bool BodyRequired { get; init; }
}
