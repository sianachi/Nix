namespace Nix.Persistence.RabbitMq;

/// <summary>Versioned broker names shared with deployment definitions and Go consumers.</summary>
public static class RabbitMqNames
{
    public const string CommandsExchange = "nix.commands.v1";
    public const string ResultsExchange = "nix.results.v1";
    public const string WorkspaceExchange = "nix.workspace.v1";
    public const string CapabilitiesExchange = "nix.capabilities.v1";
    public const string ResultsQueue = "nix.api.results.v1";
    public const string WorkerCommandKind = "worker.command";
}
