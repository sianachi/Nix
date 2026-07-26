namespace Nix.Application;

/// <summary>
/// Assembly anchor for <c>Nix.Application</c>. The application layer depends on
/// <c>Nix.Core</c> only; infrastructure concerns enter through ports defined here.
/// </summary>
public static class ApplicationAssembly
{
    /// <summary>The <c>Nix.Application</c> assembly.</summary>
    public static System.Reflection.Assembly Assembly => typeof(ApplicationAssembly).Assembly;
}
