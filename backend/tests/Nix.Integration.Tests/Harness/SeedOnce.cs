namespace Nix.Integration.Tests.Harness;

/// <summary>
/// Runs a class's reset-and-seed once instead of once per test, for classes whose tests only read
/// what the seed built.
/// </summary>
/// <remarks>
/// Hold one in a <c>static readonly</c> field. It relies on xunit running a collection's classes one
/// after another, so no other class resets the database between this class's first and last test.
/// A class whose tests write rows other tests then read must keep its per-test reset.
/// </remarks>
public sealed class SeedOnce
{
    private readonly object _lock = new();
    private Task? _seeding;

    /// <summary>Runs <paramref name="seed"/> the first time only; later callers await the same task.</summary>
    /// <param name="seed">The reset and seed work.</param>
    /// <returns>A task that completes when the database holds the seed.</returns>
    public Task RunAsync(Func<Task> seed)
    {
        ArgumentNullException.ThrowIfNull(seed);

        lock (_lock)
        {
            return _seeding ??= seed();
        }
    }
}
