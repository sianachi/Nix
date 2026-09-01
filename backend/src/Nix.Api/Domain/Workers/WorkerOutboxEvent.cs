using Nix.Domain.Items;
using Nix.Domain.Tenancy;

namespace Nix.Domain.Workers;

/// <summary>Durable rebuildable event consumed by indexing and other derived-data workers.</summary>
public sealed class WorkerOutboxEvent
{
    /// <summary>Gets the event identity.</summary>
    public required WorkerOutboxEventId Id { get; init; }
    /// <summary>Gets the tenant scope.</summary>
    public required TenantId TenantId { get; init; }
    /// <summary>Gets the workspace scope.</summary>
    public WorkspaceId? WorkspaceId { get; init; }
    /// <summary>Gets the changed item, when applicable.</summary>
    public ItemId? ItemId { get; init; }
    /// <summary>Gets the event kind.</summary>
    public required string Kind { get; init; }
    /// <summary>Gets the source version.</summary>
    public long? AggregateVersion { get; init; }
    /// <summary>Gets the serialized event body.</summary>
    public required string Payload { get; init; }
    /// <summary>Gets when processing may begin.</summary>
    public required DateTimeOffset AvailableAt { get; set; }
    /// <summary>Gets the number of delivery attempts.</summary>
    public int Attempts { get; set; }
    /// <summary>Gets the lease owner.</summary>
    public string? LeaseOwner { get; set; }
    /// <summary>Gets when the lease expires.</summary>
    public DateTimeOffset? LeaseUntil { get; set; }
    /// <summary>Gets when processing succeeded.</summary>
    public DateTimeOffset? ProcessedAt { get; set; }
    /// <summary>Gets the latest failure detail.</summary>
    public string? LastError { get; set; }
}
