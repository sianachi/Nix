namespace Nix.Infrastructure.Persistence;

/// <summary>
/// Configuration for the application's connection to Postgres.
/// </summary>
public sealed class NixPersistenceOptions
{
    /// <summary>
    /// Gets the connection string for the runtime role.
    /// </summary>
    /// <remarks>
    /// Must authenticate as <c>nix_app</c>, or another role that can neither bypass row-level
    /// security nor create objects in the schema. Never the migration role.
    /// </remarks>
    public required string ConnectionString { get; init; }

    /// <summary>
    /// Gets how long a statement may run before Npgsql cancels it. Defaults to 30 seconds.
    /// </summary>
    /// <remarks>
    /// A per-request budget, not a batch-job budget. Long work belongs in the job queue, where a
    /// timeout means a retry rather than a request hanging on to a pooled connection.
    /// </remarks>
    public TimeSpan CommandTimeout { get; init; } = TimeSpan.FromSeconds(30);
}
