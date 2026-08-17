using Nix.Domain.Identity;
using Nix.Domain.Items;
using Nix.Domain.Tenancy;

namespace Nix.Domain.Templates;

/// <summary>A workspace-visible catalog entry whose content is an ordinary hidden item tree.</summary>
public sealed class WorkspaceTemplate
{
    /// <summary>Gets the stable catalog identity.</summary>
    public required TemplateId Id { get; init; }

    /// <summary>Gets the owning tenant.</summary>
    public required TenantId TenantId { get; init; }

    /// <summary>Gets the workspace whose members may use it.</summary>
    public required WorkspaceId WorkspaceId { get; init; }

    /// <summary>Gets the active hidden root, if a revision is available.</summary>
    public ItemId? RootItemId { get; set; }

    /// <summary>Gets the staged replacement root, if one is being hydrated.</summary>
    public ItemId? PendingRootItemId { get; set; }

    /// <summary>Gets the stable seed/archive key used for reconciliation.</summary>
    public required string StableKey { get; init; }

    /// <summary>Gets the portable profile key preserved across archive round trips.</summary>
    public required string ProfileKey { get; init; }

    /// <summary>Gets where the catalog entry is governed.</summary>
    public required TemplateOrigin Origin { get; init; }

    /// <summary>Gets the display title.</summary>
    public required string Title { get; set; }

    /// <summary>Gets the optional short explanation.</summary>
    public string? Description { get; set; }

    /// <summary>Gets whether the root body belongs to this template.</summary>
    public required bool IncludeBody { get; init; }

    /// <summary>Gets whether descendants belong to this template.</summary>
    public required bool IncludeChildren { get; init; }

    /// <summary>Gets an internal managed source label; never published.</summary>
    public string? ManagedSource { get; set; }

    /// <summary>Gets the digest of the last managed/archive input.</summary>
    public string? SourceDigest { get; set; }

    /// <summary>Gets catalog visibility.</summary>
    public required TemplateState State { get; set; }

    /// <summary>Gets the monotonically increasing managed revision.</summary>
    public required int Revision { get; set; }

    /// <summary>Gets who first created the catalog identity.</summary>
    public required PrincipalId CreatedBy { get; init; }

    /// <summary>Gets who last changed it.</summary>
    public required PrincipalId LastModifiedBy { get; set; }

    /// <summary>Gets when it was created.</summary>
    public required DateTimeOffset CreatedAt { get; init; }

    /// <summary>Gets when it was changed.</summary>
    public required DateTimeOffset LastModifiedAt { get; set; }
}
