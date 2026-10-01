namespace Nix.Abstractions.Scheduling;

/// <summary>
/// The one place that checks every registered <see cref="ITriggerSource"/> has a unique
/// <see cref="ITriggerSource.Name"/>.
/// </summary>
/// <remarks>
/// The dispatcher resolves a leased trigger's fire action by <see cref="ITriggerSource.Name"/>
/// alone, never by <see cref="ITriggerSource.Kind"/> - so a collision would make that resolution
/// silently ambiguous (whichever source registered second would shadow the first for every
/// trigger the first source ever planned). Checked eagerly, every planning pass, rather than only
/// at composition time, because <see cref="ITriggerSource"/> is resolved from a fresh DI scope
/// each pass and a collision introduced by a later registration must not wait for a restart to
/// surface.
/// </remarks>
public static class TriggerSourceNames
{
    /// <summary>Throws when two or more registered sources share a <see cref="ITriggerSource.Name"/>.</summary>
    /// <param name="sources">Every currently registered trigger source.</param>
    /// <exception cref="InvalidOperationException">Two or more sources share a name.</exception>
    public static void RequireUnique(IReadOnlyCollection<ITriggerSource> sources)
    {
        ArgumentNullException.ThrowIfNull(sources);

        var seen = new HashSet<string>(StringComparer.Ordinal);
        foreach (var source in sources)
        {
            if (!seen.Add(source.Name))
            {
                throw new InvalidOperationException(
                    $"Two or more registered trigger sources share the name '{source.Name}'; "
                        + "the dispatcher could not tell them apart.");
            }
        }
    }
}
