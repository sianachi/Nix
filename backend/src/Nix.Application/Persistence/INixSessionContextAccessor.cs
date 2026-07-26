namespace Nix.Application.Persistence;

/// <summary>
/// Supplies the <see cref="NixSessionContext"/> for the current unit of work.
/// </summary>
/// <remarks>
/// <para>
/// This port exists because the context has two genuinely different sources, and neither may
/// know about the other: the HTTP pipeline derives it from the validated token, and background
/// workers derive it from the job row they claimed. Both set it once per DI scope; persistence
/// only ever reads it.
/// </para>
/// <para>
/// Reading returns <see langword="null"/> when nothing has been established. Persistence treats
/// that as a fault rather than as "no filtering": a unit of work without a tenant is a bug, and
/// silently running unscoped is how cross-tenant reads happen.
/// </para>
/// </remarks>
public interface INixSessionContextAccessor
{
    /// <summary>
    /// Gets the context for the current scope, or <see langword="null"/> if none was set.
    /// </summary>
    public NixSessionContext? Current { get; }
}
