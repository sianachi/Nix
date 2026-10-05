using Nix.Domain.Tenancy;

namespace Nix.Domain.Identity;

/// <summary>An email-addressed invitation and its durable transition history.</summary>
public sealed class WorkspaceInvitation
{
    /// <summary>Gets the invitation identifier.</summary>
    public required WorkspaceInvitationId Id { get; init; }

    /// <summary>Gets the owning tenant.</summary>
    public required TenantId TenantId { get; init; }

    /// <summary>Gets the target workspace.</summary>
    public required WorkspaceId WorkspaceId { get; init; }

    /// <summary>Gets the normalized address used for exact matching.</summary>
    public required string EmailNormalized { get; init; }

    /// <summary>Gets the provisioned human offered immediate provisional access.</summary>
    public PrincipalId? TargetPrincipalId { get; init; }

    /// <summary>Gets the workspace role offered.</summary>
    public required string Role { get; init; }

    /// <summary>Gets the principal who issued the invitation.</summary>
    public required PrincipalId InvitedByPrincipalId { get; init; }

    /// <summary>Gets the invitation's lifecycle state.</summary>
    public required WorkspaceInvitationStatus Status { get; init; }

    /// <summary>Gets when the invitation was issued.</summary>
    public required DateTimeOffset InvitedAt { get; init; }

    /// <summary>Gets when the invitation was accepted.</summary>
    public DateTimeOffset? AcceptedAt { get; init; }

    /// <summary>Gets the principal who accepted the invitation.</summary>
    public PrincipalId? AcceptedByPrincipalId { get; init; }

    /// <summary>Gets when the invitation was revoked.</summary>
    public DateTimeOffset? RevokedAt { get; init; }
}
