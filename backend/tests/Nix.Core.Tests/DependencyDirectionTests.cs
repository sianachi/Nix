using Nix.Core;

namespace Nix.Core.Tests;

public sealed class DependencyDirectionTests
{
    [Fact]
    public void Core_assembly_references_no_infrastructure()
    {
        // Named for what it checks rather than for what it was once believed to check. Core carries
        // exactly one third-party reference - NodaTime, which is value types and a tz database with
        // no I/O - and the rule that matters is this list: no database, no web framework, and
        // nothing from a layer above. See ADR-0012.
        var forbiddenPrefixes = new[]
        {
            "Nix.Application",
            "Nix.Infrastructure",
            "Nix.Api",
            "Microsoft.EntityFrameworkCore",
            "Microsoft.AspNetCore",
            "Npgsql",
        };

        var referenced = CoreAssembly.Assembly
            .GetReferencedAssemblies()
            .Select(static name => name.Name ?? string.Empty)
            .ToArray();

        var violations = referenced
            .Where(name => forbiddenPrefixes.Any(prefix =>
                name.StartsWith(prefix, StringComparison.Ordinal)))
            .ToArray();

        Assert.Empty(violations);
    }
}
