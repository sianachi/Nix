using Nix.Abstractions;

namespace Nix.Persistence;

/// <summary>
/// A <see cref="INixSessionContextAccessor"/> whose value is written once per DI scope.
/// </summary>
/// <remarks>
/// <para>
/// Registered as scoped. In the HTTP host a scope is a request and the authentication pipeline
/// writes the context after the token is validated; in a background worker a scope is one claimed
/// job and the worker writes the context from the job row. Readers - the interceptor, and any
/// future consumer - depend on <see cref="INixSessionContextAccessor"/> and cannot write, so the
/// tenant of an in-flight unit of work cannot be changed underneath it.
/// </para>
/// <para>
/// <see cref="Set"/> is write-once for the same reason. Re-pointing a live scope at another
/// tenant mid-request is never legitimate, and a transaction already open would keep the old
/// context anyway - the two would silently disagree.
/// </para>
/// <para>
/// No <c>AsyncLocal</c>: an ambient value that flows across await boundaries outlives the scope
/// that set it, and the failure mode of getting that wrong is one request reading another's
/// tenant.
/// </para>
/// </remarks>
public sealed class ScopedNixSessionContextAccessor : INixSessionContextAccessor
{
    private NixSessionContext? _current;

    /// <inheritdoc />
    public NixSessionContext? Current => _current;

    /// <summary>
    /// Establishes the context for this scope.
    /// </summary>
    /// <param name="context">The scope the unit of work runs under.</param>
    /// <exception cref="ArgumentException"><paramref name="context"/> is incomplete.</exception>
    /// <exception cref="InvalidOperationException">A context was already set for this scope.</exception>
    public void Set(NixSessionContext context)
    {
        if (!context.IsComplete)
        {
            throw new ArgumentException(
                "The session context is incomplete: a real tenant and principal are required.",
                nameof(context));
        }

        if (_current is not null)
        {
            throw new InvalidOperationException(
                "The RLS session context is already set for this scope and is write-once. " +
                "Reassigning it would leave an open transaction running under the previous " +
                "tenant while later work assumes the new one. Start a new scope instead.");
        }

        _current = context;
    }
}
