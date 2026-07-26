using Nix.Application;

namespace Nix.Application.Tests;

public sealed class DependencyDirectionTests
{
    [Fact]
    public void Application_assembly_does_not_reference_infrastructure_or_web_frameworks()
    {
        var forbiddenPrefixes = new[]
        {
            "Nix.Infrastructure",
            "Nix.Api",
            "Microsoft.EntityFrameworkCore",
            "Microsoft.AspNetCore",
            "Npgsql",
        };

        var referenced = ApplicationAssembly.Assembly
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
