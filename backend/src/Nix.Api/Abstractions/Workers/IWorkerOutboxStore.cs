using Nix.Domain.Tenancy;

namespace Nix.Abstractions.Workers;

public interface IWorkerOutboxStore
{
    public ValueTask<IReadOnlyList<WorkerOutboxRecord>> LeaseAsync(TenantId tenantId, string owner, string? kind, int limit, int leaseSeconds, CancellationToken cancellationToken);
    public ValueTask<bool> AcknowledgeAsync(TenantId tenantId, Guid eventId, CancellationToken cancellationToken);
    public ValueTask<bool> FailAsync(TenantId tenantId, Guid eventId, string failureDetail, CancellationToken cancellationToken);
}

public sealed record WorkerOutboxRecord(Guid Id, string Kind, string Payload, int Attempts, DateTimeOffset AvailableAt);
