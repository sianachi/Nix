using Nix.Domain.Items;
using Nix.Domain.Tenancy;

namespace Nix.Domain.Templates;

/// <summary>Stable source-to-target identity mapping for one application.</summary>
public sealed class TemplateApplicationItem
{
    /// <summary>Gets the application.</summary>
    public required TemplateApplicationId ApplicationId { get; init; }

    /// <summary>Gets the tenant scope.</summary>
    public required TenantId TenantId { get; init; }

    /// <summary>Gets the stable source identifier carried by the template item.</summary>
    public required Guid TemplateSourceId { get; init; }

    /// <summary>Gets the current hidden source item revision.</summary>
    public required ItemId SourceItemId { get; init; }

    /// <summary>Gets the body kind retained after a source revision is retired.</summary>
    public required string ItemType { get; init; }

    /// <summary>Gets the created or matched target item.</summary>
    public required ItemId TargetItemId { get; init; }

    /// <summary>Gets whether this maps the template root.</summary>
    public required bool IsRoot { get; init; }

    /// <summary>Gets whether this application created the target envelope.</summary>
    public required bool Created { get; init; }

    /// <summary>Gets whether Collab must copy a body before finalization.</summary>
    public required bool BodyRequired { get; init; }
}
