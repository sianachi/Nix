namespace Nix.Abstractions;

/// <summary>One recorded step of a nightly backup, as the database holds it.</summary>
/// <param name="Id">The row.</param>
/// <param name="StartedAt">When the step began.</param>
/// <param name="FinishedAt">When it ended.</param>
/// <param name="Step"><c>local</c> or <c>offsite</c>.</param>
/// <param name="Status"><c>succeeded</c> or <c>failed</c>.</param>
/// <param name="SnapshotId">The restic snapshot of an off-host push, when there is one.</param>
/// <param name="Bytes">The size of the local backup directory.</param>
/// <param name="Error">A fixed phrase written by the backup scripts, with an exit code; never tool output.</param>
public sealed record BackupRun(
    Guid Id,
    DateTimeOffset StartedAt,
    DateTimeOffset FinishedAt,
    string Step,
    string Status,
    string? SnapshotId,
    long? Bytes,
    string? Error);

/// <summary>
/// Reads the instance-wide backup log through <c>nix_backup_runs</c>. Rows belong to no tenant, so
/// who may see them is decided by the caller (the operator gate), never here.
/// </summary>
public interface IBackupRunStore
{
    /// <summary>The newest runs first.</summary>
    /// <param name="limit">1 to 100; the function clamps anything else.</param>
    /// <param name="cancellationToken">Cancels the read.</param>
    /// <returns>The runs.</returns>
    public Task<IReadOnlyList<BackupRun>> ListAsync(int limit, CancellationToken cancellationToken);
}
