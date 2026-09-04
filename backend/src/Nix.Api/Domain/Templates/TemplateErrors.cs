using Nix.Domain.Primitives;

namespace Nix.Domain.Templates;

/// <summary>Stable expected failures for catalog and application work.</summary>
public static class TemplateErrors
{
    /// <summary>The template/workspace/item is absent or not visible.</summary>
    public static NixError NotFound(string message) => new("templates.not_found", message);

    /// <summary>A managed template cannot be changed in the workspace.</summary>
    public static NixError Managed(string message) => new("templates.managed", message);

    /// <summary>The caller is authenticated but is not the managed-template service identity.</summary>
    public static NixError Forbidden(string message) => new("templates.forbidden", message);

    /// <summary>The requested shape is malformed or uses unsupported vocabulary.</summary>
    public static NixError Invalid(string message) => new("templates.invalid", message);

    /// <summary>File-backed child items cannot be copied until object storage transfer is supported.</summary>
    public static NixError FileAttachmentsUnsupported() => new(
        "templates.file_attachments_unsupported",
        "Templates containing file attachments cannot be captured, edited, applied, or exported yet. Remove the file attachments and try again.");

    /// <summary>A stable key or in-progress operation conflicts.</summary>
    public static NixError Conflict(string message) => new("templates.conflict", message);

    /// <summary>Collab has not written exactly the bodies Core asked it to write.</summary>
    public static NixError BodiesIncomplete(string message) => new("templates.bodies_incomplete", message);
}
