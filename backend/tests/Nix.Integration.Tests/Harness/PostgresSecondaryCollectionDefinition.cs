namespace Nix.Integration.Tests.Harness;

/// <summary>
/// The second serial collection, with a container of its own. Two collections let xunit run two
/// halves of the suite at once without any test sharing a database with another.
/// </summary>
/// <remarks>
/// A test class belongs to exactly one of the two; the split balances measured run time, so move a
/// class here or back only for balance, never because of what it does.
/// </remarks>
[CollectionDefinition(Name)]
public sealed class PostgresSecondaryCollectionDefinition : ICollectionFixture<NixPostgresFixture>
{
    /// <summary>The collection's name.</summary>
    public const string Name = "postgres-secondary";
}
