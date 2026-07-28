using Microsoft.EntityFrameworkCore;
using Nix.Abstractions;
using Nix.Domain.Identity;

namespace Nix.Persistence.Identity;

/// <summary>
/// Principal reads inside the request's tenant scope, over EF Core.
/// </summary>
/// <remarks>
/// The opposite of <see cref="IdentityDirectory"/> in every respect that matters: it borrows the
/// unit of work's connection and transaction, so the isolation policies apply and a principal from
/// another tenant is invisible rather than merely refused. Envelope CRUD, so LINQ expresses it
/// perfectly well and there is no hand-written statement to justify.
/// </remarks>
public sealed class PrincipalDirectory : IPrincipalDirectory
{
    private readonly NixDbContext _dbContext;

    /// <summary>Initializes a new instance of the <see cref="PrincipalDirectory"/> class.</summary>
    /// <param name="dbContext">The context owning the connection and transaction.</param>
    public PrincipalDirectory(NixDbContext dbContext)
    {
        ArgumentNullException.ThrowIfNull(dbContext);
        _dbContext = dbContext;
    }

    /// <inheritdoc />
    public async ValueTask<Principal?> FindAsync(PrincipalId id, CancellationToken cancellationToken) =>
        await _dbContext.Principals
            .FirstOrDefaultAsync(principal => principal.Id == id, cancellationToken)
            .ConfigureAwait(false);
}
