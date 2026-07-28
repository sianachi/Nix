namespace Nix.Messaging;

/// <summary>
/// Answers one query.
/// </summary>
/// <typeparam name="TQuery">The query this handles.</typeparam>
/// <typeparam name="TResult">Exactly what it returns.</typeparam>
/// <remarks>
/// One implementation per query, registered explicitly - see <see cref="ICommandHandler{TCommand, TValue}"/>
/// for why there is no scanning.
/// </remarks>
public interface IQueryHandler<in TQuery, TResult>
    where TQuery : IQuery<TResult>
{
    /// <summary>Answers the query.</summary>
    /// <param name="query">What to read.</param>
    /// <param name="cancellationToken">Cancels the read.</param>
    /// <returns>The answer.</returns>
    public ValueTask<TResult> HandleAsync(TQuery query, CancellationToken cancellationToken);
}
