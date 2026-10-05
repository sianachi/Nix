using Nix.Domain.Items;
using Nix.Domain.Tenancy;

namespace Nix.Domain.Plugins;

/// <summary>Durable deduplication and lifecycle state for one event and installation pair.</summary>
public sealed class PluginEventInbox
{
    /// <summary>Gets the owning tenant.</summary>
    public required TenantId TenantId { get; init; }

    /// <summary>Gets the durable workspace event identity.</summary>
    public required Guid EventId { get; init; }

    /// <summary>Gets the installation this delivery targets.</summary>
    public required PluginInstallationId InstallationId { get; init; }

    /// <summary>Gets the event workspace.</summary>
    public required WorkspaceId WorkspaceId { get; init; }

    /// <summary>Gets the bounded event kind.</summary>
    public required string Kind { get; init; }

    /// <summary>Gets the affected item identity, when present.</summary>
    public ItemId? ItemId { get; init; }

    /// <summary>Gets the aggregate version carried by the source event.</summary>
    public long? AggregateVersion { get; init; }

    /// <summary>Gets the causal root identity.</summary>
    public required Guid CausationId { get; init; }

    /// <summary>Gets the bounded causal depth.</summary>
    public required int CausationDepth { get; init; }

    /// <summary>Gets the invocation lifecycle.</summary>
    public required string Status { get; set; }

    /// <summary>Gets the number of durable execution attempts.</summary>
    public required int Attempts { get; set; }

    /// <summary>Gets the currently active invocation attempt.</summary>
    public PluginInvocationId? CurrentInvocationId { get; set; }

    /// <summary>Gets the stable terminal failure code.</summary>
    public string? ErrorCode { get; set; }

    /// <summary>Gets the bounded safe failure detail.</summary>
    public string? ErrorDetail { get; set; }

    /// <summary>Gets when the inbox row was created.</summary>
    public required DateTimeOffset CreatedAt { get; init; }

    /// <summary>Gets when the inbox state last changed.</summary>
    public required DateTimeOffset UpdatedAt { get; set; }

    /// <summary>Gets when the event-installation pair became terminal.</summary>
    public DateTimeOffset? CompletedAt { get; set; }
}
