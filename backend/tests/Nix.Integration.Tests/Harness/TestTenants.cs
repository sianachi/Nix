using Nix.Application.Persistence;

namespace Nix.Integration.Tests.Harness;

/// <summary>
/// Two tenants, always.
/// </summary>
/// <remarks>
/// A single-tenant isolation test proves nothing: a mechanism that returns every row in the table
/// passes it. Every test here seeds both tenants and asserts from both sides - what Alpha can see
/// and, just as importantly, what Alpha cannot.
/// </remarks>
internal static class TestTenants
{
    /// <summary>The first tenant.</summary>
    public static readonly Guid Alpha = new("11111111-1111-4111-8111-111111111111");

    /// <summary>The second tenant. Its rows are the ones that must never appear.</summary>
    public static readonly Guid Beta = new("22222222-2222-4222-8222-222222222222");

    private static readonly Guid AlphaWorkspace = new("1a1a1a1a-1111-4111-8111-1a1a1a1a1a1a");
    private static readonly Guid AlphaPrincipal = new("1b1b1b1b-1111-4111-8111-1b1b1b1b1b1b");
    private static readonly Guid BetaWorkspace = new("2a2a2a2a-2222-4222-8222-2a2a2a2a2a2a");
    private static readonly Guid BetaPrincipal = new("2b2b2b2b-2222-4222-8222-2b2b2b2b2b2b");

    /// <summary>Gets a session context for the first tenant.</summary>
    public static NixSessionContext AlphaContext => new(Alpha, AlphaWorkspace, AlphaPrincipal);

    /// <summary>Gets a session context for the second tenant.</summary>
    public static NixSessionContext BetaContext => new(Beta, BetaWorkspace, BetaPrincipal);
}
