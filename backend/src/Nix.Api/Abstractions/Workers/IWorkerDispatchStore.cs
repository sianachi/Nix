namespace Nix.Abstractions.Workers;

public interface IWorkerDispatchStore
{
    public ValueTask<IReadOnlyList<DispatchedWorkerJob>> LeaseJobsAsync(string? kind, string owner, int limit, int leaseSeconds, CancellationToken cancellationToken);
    public ValueTask<bool> FinishJobAsync(Guid jobId, string owner, bool succeeded, bool retryable, string? result, string? errorCode, string? errorDetail, CancellationToken cancellationToken);
    public ValueTask<IReadOnlyList<DispatchedOutboxEvent>> LeaseOutboxAsync(string? kind, string owner, int limit, int leaseSeconds, CancellationToken cancellationToken);
    public ValueTask<bool> FinishOutboxAsync(Guid eventId, string owner, bool succeeded, string? failureDetail, CancellationToken cancellationToken);
}

public sealed record DispatchedWorkerJob(Guid Id, Guid TenantId, Guid? WorkspaceId, Guid? ActorId, string Kind, string Payload, int Attempts, bool CancellationRequested);
public sealed record DispatchedOutboxEvent(Guid Id, Guid TenantId, Guid? WorkspaceId, Guid? ItemId, string Kind, string Payload, int Attempts, DateTimeOffset AvailableAt);
