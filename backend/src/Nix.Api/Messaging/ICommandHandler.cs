using Nix.Domain.Primitives;

namespace Nix.Messaging;

/// <summary>
/// Executes one command.
/// </summary>
/// <typeparam name="TCommand">The command this handles.</typeparam>
/// <typeparam name="TValue">What it produces on success.</typeparam>
/// <remarks>
/// One implementation per command, registered explicitly. There is no assembly scanning: a handler
/// that is not registered is a resolution failure at the first request rather than a compile error,
/// which is why <c>CompositionRootTests</c> resolves every registered handler.
/// </remarks>
public interface ICommandHandler<in TCommand, TValue>
    where TCommand : ICommand<TValue>
{
    /// <summary>Runs the command.</summary>
    /// <param name="command">What to do.</param>
    /// <param name="cancellationToken">Cancels the work.</param>
    /// <returns>The value produced, or why it could not be.</returns>
    public ValueTask<Result<TValue>> HandleAsync(TCommand command, CancellationToken cancellationToken);
}
