using Nix.Domain.Identity;
using Nix.Domain.Items;
using Nix.Domain.Tenancy;

namespace Nix.Domain.Templates;

/// <summary>Durable staging protocol for capture and archive hydration.</summary>
public sealed class TemplateOperation
{
    /// <summary>Gets the operation identity.</summary>
    public required TemplateOperationId Id { get; init; }

    /// <summary>Gets the tenant scope.</summary>
    public required TenantId TenantId { get; init; }

    /// <summary>Gets the target workspace.</summary>
    public required WorkspaceId WorkspaceId { get; init; }

    /// <summary>Gets the catalog entry being prepared.</summary>
    public required TemplateId TemplateId { get; init; }

    /// <summary>Gets the kind of preparation.</summary>
    public required TemplateOperationKind Kind { get; init; }

    /// <summary>Gets the caller's retry key.</summary>
    public required string IdempotencyKey { get; init; }

    /// <summary>Gets the ordinary root captured by a capture operation.</summary>
    public ItemId? SourceItemId { get; init; }

    /// <summary>Gets the acting principal.</summary>
    public required PrincipalId ActorId { get; init; }

    /// <summary>Gets the requested catalog title for capture/edit request equivalence.</summary>
    public string? DraftTitle { get; set; }

    /// <summary>Gets the requested catalog description for capture/edit request equivalence.</summary>
    public string? DraftDescription { get; set; }

    /// <summary>Gets the managed source being staged by an import.</summary>
    public string? ManagedSource { get; set; }

    /// <summary>Gets the archive digest being staged by an import.</summary>
    public string? SourceDigest { get; set; }

    /// <summary>Gets the operation state.</summary>
    public required TemplateOperationState State { get; set; }

    /// <summary>Gets when staging began.</summary>
    public required DateTimeOffset CreatedAt { get; init; }

    /// <summary>Gets when abandoned staging becomes eligible for cleanup.</summary>
    public required DateTimeOffset ExpiresAt { get; init; }

    /// <summary>Gets when the operation completed.</summary>
    public DateTimeOffset? FinalizedAt { get; set; }
}
