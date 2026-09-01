using Nix.Domain.Primitives;

namespace Nix.Domain.Plugins;

/// <summary>Identifies one bounded execution attempt for a plugin event.</summary>
public readonly record struct PluginInvocationId(Guid Value) : INixId<PluginInvocationId>
{
    /// <inheritdoc />
    public static PluginInvocationId From(Guid value) => new(value);

    /// <inheritdoc />
    public static PluginInvocationId Create() => new(Guid.CreateVersion7());

    /// <inheritdoc />
    public override string ToString() => Value.ToString("D");
}
