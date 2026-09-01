namespace Nix.Domain.Plugins;

/// <summary>Closed security bounds shared by plugin persistence and the internal contract.</summary>
public static class PluginRuntimePolicy
{
    /// <summary>The only host capability implemented by this read-only runtime slice.</summary>
    public const string ReadItemMetadataCapability = "items.read-metadata";

    /// <summary>Highest accepted causation depth for any plugin invocation.</summary>
    public const int MaximumCausationDepth = 4;

    /// <summary>Maximum attempts for one event and installation pair.</summary>
    public const int MaximumAttempts = 5;

    /// <summary>Maximum enabled or disabled installations retained by one workspace.</summary>
    public const int MaximumInstallationsPerWorkspace = 64;

    /// <summary>Maximum immutable WebAssembly component size.</summary>
    public const long MaximumComponentBytes = 8 * 1024 * 1024;
}
