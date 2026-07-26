namespace Nix.Integration.Tests.Harness;

/// <summary>
/// Groups every test that touches the database, so they share one container and run one at a
/// time.
/// </summary>
/// <remarks>
/// Serialised deliberately. Respawn gives each test its own data by emptying the database between
/// tests, which only works if no other test is mid-flight. The cost is small - these tests are
/// milliseconds each once the container is up - and the alternative, per-test schemas, would hide
/// exactly the kind of cross-request interference this suite exists to catch.
/// </remarks>
[CollectionDefinition(Name, DisableParallelization = true)]
public sealed class PostgresCollectionDefinition : ICollectionFixture<NixPostgresFixture>
{
    /// <summary>The collection's name.</summary>
    public const string Name = "postgres";
}
