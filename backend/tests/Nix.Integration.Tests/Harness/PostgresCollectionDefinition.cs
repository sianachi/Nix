namespace Nix.Integration.Tests.Harness;

/// <summary>
/// Groups half of the tests that touch the database, so they share one container and run one at a
/// time. <see cref="PostgresSecondaryCollectionDefinition"/> holds the other half.
/// </summary>
/// <remarks>
/// Serialised deliberately. Respawn gives each test its own data by emptying the database between
/// tests, which only works if no other test is mid-flight. The cost is small - these tests are
/// milliseconds each once the container is up - and the alternative, per-test schemas, would hide
/// exactly the kind of cross-request interference this suite exists to catch. Serial within a
/// collection, but this collection and the secondary one run side by side, each against its own
/// container, so Respawn still never shares a database with a running test.
/// </remarks>
[CollectionDefinition(Name)]
public sealed class PostgresCollectionDefinition : ICollectionFixture<NixPostgresFixture>
{
    /// <summary>The collection's name.</summary>
    public const string Name = "postgres";
}
