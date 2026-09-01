using System.Text;
using System.Text.Json.Nodes;
using Nix.Abstractions;
using Nix.Domain.Content;
using Nix.Domain.Primitives;
using Nix.Messaging;

namespace Nix.Features.Canvas;

/// <summary>Replaces the caller's own canvas library wholesale.</summary>
/// <param name="Items">
/// The library's complete contents. A save is a replace, not a merge.
/// </param>
public sealed record SaveCanvasLibrary(JsonArray Items) : ICommand<CanvasLibraryItems>;

/// <summary>Handles <see cref="SaveCanvasLibrary"/>.</summary>
public sealed class SaveCanvasLibraryHandler : ICommandHandler<SaveCanvasLibrary, CanvasLibraryItems>
{
    /// <summary>
    /// The same bound the database enforces via <c>canvas_library_items_bounded</c>. Checked here
    /// too so an oversized library is refused with a code the client can branch on, rather than
    /// surfacing as an opaque constraint-violation failure from the database.
    /// </summary>
    private const int MaxLibraryBytes = 1024 * 1024;

    private readonly ICanvasLibraryStore _store;
    private readonly INixSessionContextAccessor _session;
    private readonly TimeProvider _clock;

    /// <summary>Initializes a new instance of the <see cref="SaveCanvasLibraryHandler"/> class.</summary>
    /// <param name="store">Canvas library storage.</param>
    /// <param name="session">The tenant and principal this request runs as.</param>
    /// <param name="clock">The clock.</param>
    public SaveCanvasLibraryHandler(ICanvasLibraryStore store, INixSessionContextAccessor session, TimeProvider clock)
    {
        ArgumentNullException.ThrowIfNull(store);
        ArgumentNullException.ThrowIfNull(session);
        ArgumentNullException.ThrowIfNull(clock);

        _store = store;
        _session = session;
        _clock = clock;
    }

    /// <summary>Writes the library.</summary>
    /// <param name="command">The library's new contents.</param>
    /// <param name="cancellationToken">Cancels the write.</param>
    /// <returns>The saved library, or why it could not be written.</returns>
    public async ValueTask<Result<CanvasLibraryItems>> HandleAsync(
        SaveCanvasLibrary command,
        CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(command);

        var context = _session.Current
            ?? throw new InvalidOperationException("No session context; the pipeline must establish one.");

        var json = command.Items.ToJsonString();
        if (Encoding.UTF8.GetByteCount(json) > MaxLibraryBytes)
        {
            return Result.Failure<CanvasLibraryItems>(CanvasErrors.LibraryTooLarge());
        }

        await _store
            .SaveAsync(
                new CanvasLibrary
                {
                    PrincipalId = context.PrincipalId,
                    TenantId = context.TenantId,
                    LibraryItemsJson = json,
                    UpdatedAt = _clock.GetUtcNow(),
                },
                cancellationToken)
            .ConfigureAwait(false);

        return Result.Success(new CanvasLibraryItems(command.Items));
    }
}
