using System.Globalization;
using Microsoft.EntityFrameworkCore;
using Nix.Abstractions.Automations;

namespace Nix.Persistence.Automations;

/// <summary>
/// Backs <see cref="IAutomationActionScope"/> on the unit of work's own connection and transaction:
/// a plain <c>SAVEPOINT</c> (the dispatcher and the request pipeline both already hold a
/// transaction) and <c>set_config(..., true)</c>, which is transaction-local and is also undone by a
/// rollback to the savepoint.
/// </summary>
public sealed class AutomationActionScope(NixDbContext database) : IAutomationActionScope
{
    private const string Savepoint = "automation_actions";

    public async Task BeginAsync(int depth, CancellationToken cancellationToken)
    {
        await database.Database.ExecuteSqlRawAsync($"SAVEPOINT {Savepoint}", cancellationToken).ConfigureAwait(false);
        var text = depth.ToString(CultureInfo.InvariantCulture);
        await database.Database.ExecuteSqlInterpolatedAsync(
            $"SELECT set_config('nix.automation_depth', {text}, true)", cancellationToken).ConfigureAwait(false);
    }

    public async Task RollbackAsync(CancellationToken cancellationToken)
    {
        await database.Database.ExecuteSqlRawAsync($"ROLLBACK TO SAVEPOINT {Savepoint}", cancellationToken).ConfigureAwait(false);

        // Rows the actions inserted through EF are gone from the database; forget them here too.
        database.ChangeTracker.Clear();
        await ResetAsync(cancellationToken).ConfigureAwait(false);
    }

    public async Task CompleteAsync(CancellationToken cancellationToken)
    {
        await database.Database.ExecuteSqlRawAsync($"RELEASE SAVEPOINT {Savepoint}", cancellationToken).ConfigureAwait(false);
        await ResetAsync(cancellationToken).ConfigureAwait(false);
    }

    private Task<int> ResetAsync(CancellationToken cancellationToken) =>
        database.Database.ExecuteSqlRawAsync("SELECT set_config('nix.automation_depth', '0', true)", cancellationToken);
}
