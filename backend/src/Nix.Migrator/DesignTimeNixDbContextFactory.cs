using System.Diagnostics.CodeAnalysis;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Design;
using Nix.Persistence;

namespace Nix.Migrator;

/// <summary>
/// Lets the <c>dotnet ef</c> tooling construct a <see cref="NixDbContext"/> without starting the
/// application.
/// </summary>
/// <remarks>
/// <para>
/// Scaffolding a migration only needs the model and the provider, not a live server, so the
/// placeholder connection string below is never dialled for <c>migrations add</c>. Commands that
/// do reach the database (<c>database update</c>, <c>migrations script --idempotent</c>) need a
/// real one in <c>NIX_MIGRATOR_CONNECTION_STRING</c>.
/// </para>
/// <code>
/// dotnet ef migrations add &lt;Name&gt; \
///   --project backend/src/Nix.Api \
///   --startup-project backend/src/Nix.Migrator \
///   --output-dir Persistence/Migrations/Generated
/// </code>
/// <para>
/// Migrations are generated into <c>Nix.Api</c> so the runtime assembly carries them; this
/// project only hosts the entry point.
/// </para>
/// </remarks>
[SuppressMessage(
    "Performance",
    "CA1812:Avoid uninstantiated internal classes",
    Justification = "Discovered and instantiated by reflection by the dotnet-ef design-time tooling.")]
internal sealed class DesignTimeNixDbContextFactory : IDesignTimeDbContextFactory<NixDbContext>
{
    private const string PlaceholderConnectionString =
        "Host=localhost;Port=5433;Database=nix;Username=nix_migrator";

    public NixDbContext CreateDbContext(string[] args)
    {
        var connectionString = Environment.GetEnvironmentVariable("NIX_MIGRATOR_CONNECTION_STRING")
            ?? PlaceholderConnectionString;

        var options = new DbContextOptionsBuilder<NixDbContext>()
            .UseNpgsql(connectionString)
            .Options;

        return new NixDbContext(options);
    }
}
