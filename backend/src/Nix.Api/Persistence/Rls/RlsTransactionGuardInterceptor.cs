using System.Data.Common;
using Microsoft.EntityFrameworkCore.Diagnostics;

namespace Nix.Persistence.Rls;

/// <summary>
/// Refuses to execute a command on <see cref="NixDbContext"/> outside a transaction.
/// </summary>
/// <remarks>
/// <para>
/// The session context is published with <c>SET LOCAL</c>, which exists only inside a
/// transaction. A statement executed outside one therefore carries no tenant at all, and the
/// row-level security policies answer it with zero rows. That is fail-closed, but it is also
/// silent: the symptom is an empty list, which reads like missing data rather than a broken
/// security mechanism, and the usual "fix" is to widen a policy.
/// </para>
/// <para>
/// So the mistake is made loud instead. Every unit of work opens a transaction; there is no
/// read-only shortcut. This guard is not the security boundary - RLS is - it is what keeps the
/// boundary from being defeated by an accident that looks like a data bug.
/// </para>
/// <para>
/// Only <see cref="NixDbContext"/> is affected. The migration runner builds its context without
/// interceptors, and DDL applied by the migrator is outside this path by construction.
/// </para>
/// </remarks>
public sealed class RlsTransactionGuardInterceptor : DbCommandInterceptor
{
    /// <inheritdoc />
    public override InterceptionResult<DbDataReader> ReaderExecuting(
        DbCommand command,
        CommandEventData eventData,
        InterceptionResult<DbDataReader> result)
    {
        Guard(command);
        return base.ReaderExecuting(command, eventData, result);
    }

    /// <inheritdoc />
    public override ValueTask<InterceptionResult<DbDataReader>> ReaderExecutingAsync(
        DbCommand command,
        CommandEventData eventData,
        InterceptionResult<DbDataReader> result,
        CancellationToken cancellationToken = default)
    {
        Guard(command);
        return base.ReaderExecutingAsync(command, eventData, result, cancellationToken);
    }

    /// <inheritdoc />
    public override InterceptionResult<object> ScalarExecuting(
        DbCommand command,
        CommandEventData eventData,
        InterceptionResult<object> result)
    {
        Guard(command);
        return base.ScalarExecuting(command, eventData, result);
    }

    /// <inheritdoc />
    public override ValueTask<InterceptionResult<object>> ScalarExecutingAsync(
        DbCommand command,
        CommandEventData eventData,
        InterceptionResult<object> result,
        CancellationToken cancellationToken = default)
    {
        Guard(command);
        return base.ScalarExecutingAsync(command, eventData, result, cancellationToken);
    }

    /// <inheritdoc />
    public override InterceptionResult<int> NonQueryExecuting(
        DbCommand command,
        CommandEventData eventData,
        InterceptionResult<int> result)
    {
        Guard(command);
        return base.NonQueryExecuting(command, eventData, result);
    }

    /// <inheritdoc />
    public override ValueTask<InterceptionResult<int>> NonQueryExecutingAsync(
        DbCommand command,
        CommandEventData eventData,
        InterceptionResult<int> result,
        CancellationToken cancellationToken = default)
    {
        Guard(command);
        return base.NonQueryExecutingAsync(command, eventData, result, cancellationToken);
    }

    private static void Guard(DbCommand command)
    {
        ArgumentNullException.ThrowIfNull(command);

        if (command.Transaction is not null)
        {
            return;
        }

        throw new InvalidOperationException(
            "Refusing to run a statement outside a transaction. The RLS session context is " +
            "published with SET LOCAL, which only exists inside one, so this statement would be " +
            "evaluated with no tenant and quietly return nothing. Open a transaction for the " +
            $"unit of work (for example {nameof(NixDbContext)}.Database.BeginTransactionAsync) " +
            $"and run the work inside it. Statement: {command.CommandText}");
    }
}
