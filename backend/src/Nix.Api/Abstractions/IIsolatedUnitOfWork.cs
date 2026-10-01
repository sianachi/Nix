namespace Nix.Abstractions;

/// <summary>What an isolated unit of work produced, and whether to keep it.</summary>
/// <param name="Value">The work's result.</param>
/// <param name="Commit">Whether the work's writes commit; otherwise they roll back.</param>
public readonly record struct IsolatedOutcome<T>(T Value, bool Commit);

/// <summary>
/// Runs work in a fresh DI scope bound to a given session, inside a transaction of its own that
/// commits or rolls back independently of whatever transaction the caller is in.
/// </summary>
/// <remarks>
/// For the few writes that must outlive the caller's own outcome - a rotated OAuth refresh token,
/// a <c>needs_reauth</c> mark and its notification during a worker execution whose response is
/// about to roll back - and for boundaries that establish their own session, such as the BFF
/// calendar callback. The session is set before the transaction begins, so row security scopes
/// every statement in it exactly as it would a request's. The cancellation token reaches the
/// work, never the commit: work that finished and asked to commit is kept even if the caller's
/// request was aborted meanwhile.
/// </remarks>
public interface IIsolatedUnitOfWork
{
    /// <summary>Runs <paramref name="work"/> as <paramref name="context"/> in its own scope and transaction.</summary>
    public Task<T> RunAsync<T>(
        NixSessionContext context,
        Func<IServiceProvider, CancellationToken, Task<IsolatedOutcome<T>>> work,
        CancellationToken cancellationToken);
}
