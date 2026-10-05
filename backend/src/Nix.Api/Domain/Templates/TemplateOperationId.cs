using Nix.Domain.Primitives;

namespace Nix.Domain.Templates;

/// <summary>Identifies a staged capture or import until its bodies are complete.</summary>
public readonly record struct TemplateOperationId(Guid Value) : INixId<TemplateOperationId>
{
    /// <inheritdoc />
    public static TemplateOperationId From(Guid value) => new(value);

    /// <summary>Creates a new operation identity.</summary>
    public static TemplateOperationId Create() => new(Guid.CreateVersion7());

    /// <inheritdoc />
    public override string ToString() => Value.ToString("D");
}
