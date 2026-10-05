using Nix.Domain.Primitives;

namespace Nix.Domain.Templates;

/// <summary>Stable identity of one workspace template across managed revisions.</summary>
public readonly record struct TemplateId(Guid Value) : INixId<TemplateId>
{
    /// <inheritdoc />
    public static TemplateId From(Guid value) => new(value);

    /// <summary>Creates a new template identity.</summary>
    public static TemplateId Create() => new(Guid.CreateVersion7());

    /// <inheritdoc />
    public override string ToString() => Value.ToString("D");
}
