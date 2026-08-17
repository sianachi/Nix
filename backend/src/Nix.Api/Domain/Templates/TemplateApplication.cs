using Nix.Domain.Identity;
using Nix.Domain.Items;
using Nix.Domain.Tenancy;

namespace Nix.Domain.Templates;

/// <summary>One idempotent template merge or creation.</summary>
public sealed class TemplateApplication
{
    /// <summary>Gets the application identity.</summary>
    public required TemplateApplicationId Id { get; init; }

    /// <summary>Gets the tenant scope.</summary>
    public required TenantId TenantId { get; init; }

    /// <summary>Gets the workspace receiving the template.</summary>
    public required WorkspaceId WorkspaceId { get; init; }

    /// <summary>Gets the template used.</summary>
    public required TemplateId TemplateId { get; init; }

    /// <summary>Gets the root item receiving the template.</summary>
    public required ItemId TargetItemId { get; init; }

    /// <summary>Gets the requested parent for a create application.</summary>
    public ItemId? ParentItemId { get; init; }

    /// <summary>Gets the effective requested title for a create application.</summary>
    public string? RequestedTitle { get; init; }

    /// <summary>Gets whether this merged or created.</summary>
    public required TemplateApplicationMode Mode { get; init; }

    /// <summary>Gets the caller's retry key.</summary>
    public required string IdempotencyKey { get; init; }

    /// <summary>Gets the acting principal.</summary>
    public required PrincipalId ActorId { get; init; }

    /// <summary>Gets the application state.</summary>
    public required TemplateOperationState State { get; set; }

    /// <summary>Gets when application began.</summary>
    public required DateTimeOffset CreatedAt { get; init; }

    /// <summary>Gets when abandoned staging becomes eligible for cleanup.</summary>
    public required DateTimeOffset ExpiresAt { get; init; }

    /// <summary>Gets when the result became visible.</summary>
    public DateTimeOffset? FinalizedAt { get; set; }
}
