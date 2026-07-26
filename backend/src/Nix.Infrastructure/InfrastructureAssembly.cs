namespace Nix.Infrastructure;

/// <summary>
/// Assembly anchor for <c>Nix.Infrastructure</c>. Implements the ports defined in
/// <c>Nix.Application</c>; never referenced by <c>Nix.Core</c> or <c>Nix.Application</c>.
/// </summary>
public static class InfrastructureAssembly
{
    /// <summary>The <c>Nix.Infrastructure</c> assembly.</summary>
    public static System.Reflection.Assembly Assembly => typeof(InfrastructureAssembly).Assembly;
}
