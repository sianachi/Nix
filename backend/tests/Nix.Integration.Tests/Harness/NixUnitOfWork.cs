using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Storage;
using Microsoft.Extensions.DependencyInjection;
using Nix.Application.Persistence;
using Nix.Infrastructure.Persistence;
using Nix.Infrastructure.Persistence.Sql;
using Nix.Infrastructure.Persistence.Sql.Statements;
using Npgsql;

namespace Nix.Integration.Tests.Harness;

/// <summary>
/// One tenant-scoped unit of work: a DI scope, a context, an open transaction, and the SQL
/// executor sharing them.
/// </summary>
/// <remarks>
/// Shaped exactly like a request: scope opened, session context established once, transaction
/// begun (which is where the interceptor publishes the <c>SET LOCAL</c> settings), work done,
/// everything disposed together. Tests that reach for anything looser are not testing the thing
/// the application does.
/// </remarks>
internal sealed class NixUnitOfWork : IAsyncDisposable
{
    private readonly AsyncServiceScope _scope;

    private NixUnitOfWork(
        AsyncServiceScope scope,
        NixDbContext dbContext,
        NixSqlExecutor sql,
        IDbContextTransaction transaction,
        string? inheritedTenantSetting)
    {
        _scope = scope;
        DbContext = dbContext;
        Sql = sql;
        Transaction = transaction;
        InheritedTenantSetting = inheritedTenantSetting;
    }

    /// <summary>Gets the context for this unit of work.</summary>
    public NixDbContext DbContext { get; }

    /// <summary>Gets the hand-written-SQL executor sharing this unit of work's transaction.</summary>
    public NixSqlExecutor Sql { get; }

    /// <summary>Gets the open transaction whose lifetime the session context is scoped to.</summary>
    public IDbContextTransaction Transaction { get; }

    /// <summary>
    /// Gets whatever <c>nix.tenant_id</c> was already set on the physical connection when this
    /// unit of work leased it, before its own context was established.
    /// </summary>
    /// <remarks>
    /// This is the leak channel, sampled. On a pool of one, a non-empty value here means the
    /// previous unit of work left its tenant behind on the connection - which is what a plain
    /// <c>SET</c> does and what <c>SET LOCAL</c> does not. Recorded for every unit of work so any
    /// test can assert on it, and asserted explicitly by the pool-scoping proof.
    /// </remarks>
    public string? InheritedTenantSetting { get; }

    internal static async Task<NixUnitOfWork> StartAsync(
        AsyncServiceScope scope,
        NixSessionContext context,
        CancellationToken cancellationToken)
    {
        var dbContext = scope.ServiceProvider.GetRequiredService<NixDbContext>();
        var sql = scope.ServiceProvider.GetRequiredService<NixSqlExecutor>();

        // Lease the physical connection first and read it before anything establishes a tenant on
        // it. The extra reference also keeps it open across the transaction's lifetime, so the
        // connection can be questioned again afterwards.
        await dbContext.Database.OpenConnectionAsync(cancellationToken);

        string? inherited;
        try
        {
            var connection = (NpgsqlConnection)dbContext.Database.GetDbConnection();
            inherited = await RawSql.TextAsync(connection, transaction: null, SessionSql.CurrentTenantSetting);

            scope.ServiceProvider.GetRequiredService<ScopedNixSessionContextAccessor>().Set(context);
            var transaction = await dbContext.Database.BeginTransactionAsync(cancellationToken);

            return new NixUnitOfWork(scope, dbContext, sql, transaction, inherited);
        }
        catch
        {
            await dbContext.Database.CloseConnectionAsync();
            throw;
        }
    }

    /// <summary>Commits the transaction.</summary>
    /// <param name="cancellationToken">Cancels the commit.</param>
    /// <returns>A task that completes when the transaction is committed.</returns>
    public Task CommitAsync(CancellationToken cancellationToken = default) =>
        Transaction.CommitAsync(cancellationToken);

    /// <summary>
    /// Reads the tenant setting on this unit of work's physical connection, outside any
    /// transaction.
    /// </summary>
    /// <returns>The setting, or <see langword="null"/> when unset.</returns>
    public Task<string?> ReadTenantSettingOutsideTransactionAsync()
    {
        var connection = (NpgsqlConnection)DbContext.Database.GetDbConnection();
        return RawSql.TextAsync(connection, transaction: null, SessionSql.CurrentTenantSetting);
    }

    /// <inheritdoc />
    public async ValueTask DisposeAsync()
    {
        await Transaction.DisposeAsync();
        await DbContext.Database.CloseConnectionAsync();
        await _scope.DisposeAsync();
    }
}
