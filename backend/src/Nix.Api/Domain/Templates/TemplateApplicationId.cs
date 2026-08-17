using Nix.Domain.Primitives;

namespace Nix.Domain.Templates;

/// <summary>Identifies one idempotent application of a template.</summary>
public readonly record struct TemplateApplicationId(Guid Value) : INixId<TemplateApplicationId>
{
    /// <inheritdoc />
    public static TemplateApplicationId From(Guid value) => new(value);

    /// <summary>Creates a new application identity.</summary>
    public static TemplateApplicationId Create() => new(Guid.CreateVersion7());

    /// <inheritdoc />
    public override string ToString() => Value.ToString("D");
}
