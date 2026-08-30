namespace Nix.Domain.Identity;

/// <summary>The durable lifecycle of a workspace invitation.</summary>
public enum WorkspaceInvitationStatus
{
    /// <summary>May still be accepted or revoked.</summary>
    Pending = 0,

    /// <summary>Redeemed by a matching verified principal.</summary>
    Accepted = 1,

    /// <summary>Withdrawn before redemption.</summary>
    Revoked = 2,
}
