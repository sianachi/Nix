using Nix.Infrastructure;

namespace Nix.Integration.Tests;

public sealed class DependencyDirectionTests
{
    [Fact]
    public void Infrastructure_assembly_does_not_reference_the_api_host()
    {
        var referenced = InfrastructureAssembly.Assembly
            .GetReferencedAssemblies()
            .Select(static name => name.Name ?? string.Empty)
            .ToArray();

        var violations = referenced
            .Where(static name => name.StartsWith("Nix.Api", StringComparison.Ordinal))
            .ToArray();

        Assert.Empty(violations);
    }
}
