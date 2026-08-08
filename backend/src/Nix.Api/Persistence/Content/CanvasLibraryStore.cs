using Microsoft.EntityFrameworkCore;
using Nix.Abstractions;
using Nix.Domain.Content;
using Nix.Domain.Identity;

namespace Nix.Persistence.Content;

/// <summary>
/// Canvas library reads and writes inside the request's tenant scope, over EF Core.
/// </summary>
/// <remarks>
/// Envelope CRUD over a single row keyed by principal, so LINQ expresses it perfectly well and
/// there is no hand-written statement to justify.
/// </remarks>
public sealed class CanvasLibraryStore : ICanvasLibraryStore
{
    private readonly NixDbContext _dbContext;

    /// <summary>Initializes a new instance of the <see cref="CanvasLibraryStore"/> class.</summary>
    /// <param name="dbContext">The context owning the connection and transaction.</param>
    public CanvasLibraryStore(NixDbContext dbContext)
    {
        ArgumentNullException.ThrowIfNull(dbContext);
        _dbContext = dbContext;
    }

    /// <inheritdoc />
    public async ValueTask<CanvasLibrary?> FindAsync(PrincipalId principalId, CancellationToken cancellationToken) =>
        await _dbContext.CanvasLibraries
            .FirstOrDefaultAsync(library => library.PrincipalId == principalId, cancellationToken)
            .ConfigureAwait(false);

    /// <inheritdoc />
    public async Task SaveAsync(CanvasLibrary library, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(library);

        var existing = await _dbContext.CanvasLibraries
            .AsTracking()
            .FirstOrDefaultAsync(row => row.PrincipalId == library.PrincipalId, cancellationToken)
            .ConfigureAwait(false);

        if (existing is null)
        {
            _dbContext.CanvasLibraries.Add(library);
        }
        else
        {
            _dbContext.Entry(existing).CurrentValues.SetValues(library);
        }

        await _dbContext.SaveChangesAsync(cancellationToken).ConfigureAwait(false);
    }
}
