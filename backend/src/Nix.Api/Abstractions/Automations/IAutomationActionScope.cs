namespace Nix.Abstractions.Automations;

/// <summary>
/// The transaction seam an automation's actions run inside: a savepoint so they are all-or-nothing,
/// and the transaction-local causation depth (<c>nix.automation_depth</c>) the property-change
/// trigger reads while they write.
/// </summary>
/// <remarks>
/// A port rather than direct SQL in the executor, so the executor can stay beside the commands it
/// dispatches (<c>Features/</c>) without a feature touching the database itself.
/// </remarks>
public interface IAutomationActionScope
{
    /// <summary>Takes the savepoint and raises the causation depth to <paramref name="depth"/>.</summary>
    public Task BeginAsync(int depth, CancellationToken cancellationToken);

    /// <summary>Undoes everything written since <see cref="BeginAsync"/> and lowers the depth to zero.</summary>
    public Task RollbackAsync(CancellationToken cancellationToken);

    /// <summary>Keeps what was written and lowers the depth to zero.</summary>
    public Task CompleteAsync(CancellationToken cancellationToken);
}
