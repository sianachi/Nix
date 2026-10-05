using Microsoft.Extensions.DependencyInjection;
using Nix.Abstractions;

namespace Nix.Persistence;

/// <summary>
/// Backs <see cref="IIsolatedUnitOfWork"/> the way the dispatcher scopes each trigger: a new DI
/// scope, its session set before the transaction begins, and a commit only when the work asks.
/// </summary>
public sealed class IsolatedUnitOfWork(IServiceScopeFactory scopes) : IIsolatedUnitOfWork
{
    /// <inheritdoc />
    public async Task<T> RunAsync<T>(
        NixSessionContext context,
        Func<IServiceProvider, CancellationToken, Task<IsolatedOutcome<T>>> work,
        CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(work);
        var scope = scopes.CreateAsyncScope();
        await using (scope.ConfigureAwait(false))
        {
            var provider = scope.ServiceProvider;
            provider.GetRequiredService<ScopedNixSessionContextAccessor>().Set(context);
            var database = provider.GetRequiredService<NixDbContext>();
            var transaction = await database.Database.BeginTransactionAsync(cancellationToken).ConfigureAwait(false);
            await using (transaction.ConfigureAwait(false))
            {
                var outcome = await work(provider, cancellationToken).ConfigureAwait(false);
                if (outcome.Commit)
                {
                    // Once the work is done its writes must land even if the caller has gone: a
                    // rotated refresh token dropped here would leave the connection holding one the
                    // provider already invalidated.
                    await transaction.CommitAsync(CancellationToken.None).ConfigureAwait(false);
                }
                else
                {
                    await transaction.RollbackAsync(cancellationToken).ConfigureAwait(false);
                }

                return outcome.Value;
            }
        }
    }
}
