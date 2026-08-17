namespace Nix.Domain.Templates;

/// <summary>Where a template is governed.</summary>
public enum TemplateOrigin
{
    /// <summary>Shipped with Nix and read-only.</summary>
    Seed = 0,

    /// <summary>Authored or imported by a workspace editor.</summary>
    User = 1,

    /// <summary>Reconciled from the deployment's managed directory and read-only.</summary>
    Managed = 2,
}

/// <summary>Whether a catalog entry is visible or waiting for all bodies.</summary>
public enum TemplateState
{
    /// <summary>Not visible to ordinary catalog reads.</summary>
    Provisioning = 0,

    /// <summary>Available for use.</summary>
    Active = 1,

    /// <summary>A managed source was removed; its last revision is hidden but recoverable.</summary>
    Inactive = 2,
}

/// <summary>The work performed by a staged template operation.</summary>
public enum TemplateOperationKind
{
    /// <summary>Copies an existing workspace item.</summary>
    Capture = 0,

    /// <summary>Hydrates a validated template archive.</summary>
    Import = 1,

    /// <summary>Edits a copy of the active template and swaps it on save.</summary>
    Edit = 2,
}

/// <summary>Where a staged operation or application is in its protocol.</summary>
public enum TemplateOperationState
{
    /// <summary>Envelope rows exist and bodies are still being written.</summary>
    Provisioning = 0,

    /// <summary>The catalog or target was atomically made visible.</summary>
    Active = 1,

    /// <summary>The operation was abandoned and is eligible for cleanup.</summary>
    Aborted = 2,
}

/// <summary>How a template is applied.</summary>
public enum TemplateApplicationMode
{
    /// <summary>Merge schema/views and missing children into an existing item.</summary>
    Merge = 0,

    /// <summary>Create a new item and subtree.</summary>
    Create = 1,
}
