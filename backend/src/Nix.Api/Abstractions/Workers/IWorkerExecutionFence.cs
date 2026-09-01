namespace Nix.Abstractions.Workers;

/// <summary>Holds the exact live worker execution until the current transaction ends.</summary>
public interface IWorkerExecutionFence
{
    /// <summary>
    /// Validates and locks the durable job row that authorized this request. A successful hold
    /// prevents lease expiry, cancellation, or completion from racing the enclosing commit.
    /// </summary>
    public ValueTask<bool> HoldAsync(
        Guid jobId,
        string owner,
        WorkerExecutionAuthorization authorization,
        CancellationToken cancellationToken);
}
