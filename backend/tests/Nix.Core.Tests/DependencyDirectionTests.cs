using Nix.Core;

namespace Nix.Core.Tests;

public sealed class DependencyDirectionTests
{
    [Fact]
    public void Core_assembly_references_only_the_base_class_library()
    {
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
