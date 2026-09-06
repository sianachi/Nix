namespace Nix.Domain.Tenancy;

/// <summary>Where a workspace sits in its retirement lifecycle.</summary>
public enum WorkspaceLifecycleState
{
    /// <summary>Available for ordinary use.</summary>
    Active = 0,

    /// <summary>Hidden from ordinary navigation and recoverable by an authorized caller.</summary>
    Archived = 1,

    /// <summary>Irreversibly deleting durable data and object-storage bytes.</summary>
    Purging = 2,
}
