using Nix.Domain.Items;
using Nix.Domain.Tenancy;

namespace Nix.Domain.Plugins;

/// <summary>The immutable identifier-only workspace event accepted from RabbitMQ.</summary>
public sealed class PluginEventReceipt
{
    /// <summary>Gets the tenant carried by the durable event.</summary>
    public required TenantId TenantId { get; init; }

    /// <summary>Gets the durable outbox event identity.</summary>
    public required Guid EventId { get; init; }

    /// <summary>Gets the workspace that emitted the event.</summary>
    public required WorkspaceId WorkspaceId { get; init; }

    /// <summary>Gets the bounded event kind.</summary>
    public required string Kind { get; init; }

    /// <summary>Gets the affected item identity, when the event is item-scoped.</summary>
    public ItemId? ItemId { get; init; }

    /// <summary>Gets the aggregate version carried by the outbox event.</summary>
    public long? AggregateVersion { get; init; }

    /// <summary>Gets the root event that began this causal chain.</summary>
    public required Guid CausationId { get; init; }

    /// <summary>Gets the bounded number of plugin-authored hops from the root event.</summary>
    public required int CausationDepth { get; init; }

    /// <summary>Gets when Core first accepted this exact event envelope.</summary>
    public required DateTimeOffset ReceivedAt { get; init; }
}
