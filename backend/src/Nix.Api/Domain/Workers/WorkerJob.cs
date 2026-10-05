using Nix.Domain.Identity;
using Nix.Domain.Items;
using Nix.Domain.Tenancy;

namespace Nix.Domain.Workers;

/// <summary>Backend-owned lifecycle and result record for an asynchronous worker operation.</summary>
public sealed class WorkerJob
{
    /// <summary>Gets the job identity.</summary>
    public required WorkerJobId Id { get; init; }
    /// <summary>Gets the tenant scope.</summary>
    public required TenantId TenantId { get; init; }
    /// <summary>Gets the workspace scope.</summary>
    public WorkspaceId? WorkspaceId { get; init; }
    /// <summary>Gets the principal that requested the operation.</summary>
    public PrincipalId? ActorId { get; init; }
    /// <summary>Gets the worker kind.</summary>
    public required string Kind { get; init; }
    /// <summary>Gets the request idempotency key.</summary>
    public required string IdempotencyKey { get; init; }
    /// <summary>Gets the serialized, validated request.</summary>
    public required string Payload { get; init; }
    /// <summary>Gets the lifecycle state.</summary>
    public required string Status { get; set; }
    /// <summary>Gets the latest serialized result.</summary>
    public string? Result { get; set; }
    /// <summary>Gets the stable failure code.</summary>
    public string? ErrorCode { get; set; }
    /// <summary>Gets the safe failure detail.</summary>
    public string? ErrorDetail { get; set; }
    /// <summary>Gets the number of execution attempts.</summary>
    public int Attempts { get; set; }
    /// <summary>Gets the lease owner.</summary>
    public string? LeaseOwner { get; set; }
    /// <summary>Gets when the lease expires.</summary>
    public DateTimeOffset? LeaseUntil { get; set; }
    /// <summary>Gets whether cancellation has been requested.</summary>
    public bool CancellationRequested { get; set; }
    /// <summary>Gets when the job was created.</summary>
    public required DateTimeOffset CreatedAt { get; init; }
    /// <summary>Gets when execution began.</summary>
    public DateTimeOffset? StartedAt { get; set; }
    /// <summary>Gets when the job reached a terminal state.</summary>
    public DateTimeOffset? CompletedAt { get; set; }
    /// <summary>Gets when the row was last changed.</summary>
    public required DateTimeOffset UpdatedAt { get; set; }
}
