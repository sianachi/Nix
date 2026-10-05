using Nix.Domain.Content;
using Nix.Domain.Identity;

namespace Nix.Abstractions;

/// <summary>
/// Reads and writes a principal's own canvas library.
/// </summary>
/// <remarks>
/// A port because the dependency direction requires one - use cases live in this assembly and the
/// implementation needs EF Core, which only Infrastructure may reference.
/// </remarks>
public interface ICanvasLibraryStore
{
    /// <summary>Finds a principal's library in the current tenant.</summary>
    /// <param name="principalId">The owning principal.</param>
    /// <param name="cancellationToken">Cancels the read.</param>
    /// <returns>The library, or <see langword="null"/> when nothing has been saved yet.</returns>
    public ValueTask<CanvasLibrary?> FindAsync(PrincipalId principalId, CancellationToken cancellationToken);

    /// <summary>Replaces a principal's library wholesale.</summary>
    /// <param name="library">The library to save, keyed by its own <see cref="CanvasLibrary.PrincipalId"/>.</param>
    /// <param name="cancellationToken">Cancels the write.</param>
    public Task SaveAsync(CanvasLibrary library, CancellationToken cancellationToken);
}
