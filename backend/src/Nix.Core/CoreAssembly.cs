namespace Nix.Core;

/// <summary>
/// Assembly anchor for <c>Nix.Core</c>. The domain layer references only the
/// base class library; the dependency-direction test in <c>Nix.Core.Tests</c>
/// enforces this against the compiled assembly.
/// </summary>
public static class CoreAssembly
{
    /// <summary>The <c>Nix.Core</c> assembly.</summary>
    public static System.Reflection.Assembly Assembly => typeof(CoreAssembly).Assembly;
}
