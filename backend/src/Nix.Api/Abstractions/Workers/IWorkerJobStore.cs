using Nix.Domain.Identity;
using Nix.Domain.Tenancy;

namespace Nix.Abstractions.Workers;

public interface IWorkerJobStore
{
    public ValueTask<WorkerJobRecord> CreateAsync(TenantId tenantId, PrincipalId actorId, WorkspaceId? workspaceId, string kind, string idempotencyKey, string payload, CancellationToken cancellationToken);
    public ValueTask<WorkerJobRecord?> GetAsync(TenantId tenantId, PrincipalId actorId, Guid jobId, CancellationToken cancellationToken);
    public ValueTask<bool> CancelAsync(TenantId tenantId, PrincipalId actorId, Guid jobId, CancellationToken cancellationToken);
    public ValueTask<IReadOnlyList<WorkerJobRecord>> LeaseAsync(TenantId tenantId, string owner, string? kind, int limit, int leaseSeconds, CancellationToken cancellationToken);
    public ValueTask<bool> CompleteAsync(TenantId tenantId, Guid jobId, bool succeeded, string? result, string? errorCode, string? errorDetail, CancellationToken cancellationToken);
}

public sealed record WorkerJobRecord(
    Guid Id,
    string Kind,
    string Status,
    string Payload,
    string? Result,
    string? ErrorCode,
    string? ErrorDetail,
    int Attempts,
    bool CancellationRequested,
    DateTimeOffset CreatedAt,
    DateTimeOffset? CompletedAt);
