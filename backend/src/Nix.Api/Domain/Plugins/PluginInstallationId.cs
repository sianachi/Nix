using Nix.Domain.Primitives;

namespace Nix.Domain.Plugins;

/// <summary>Identifies one immutable component installation in a workspace.</summary>
public readonly record struct PluginInstallationId(Guid Value) : INixId<PluginInstallationId>
{
    /// <inheritdoc />
    public static PluginInstallationId From(Guid value) => new(value);

    /// <inheritdoc />
    public static PluginInstallationId Create() => new(Guid.CreateVersion7());

    /// <inheritdoc />
    public override string ToString() => Value.ToString("D");
}
