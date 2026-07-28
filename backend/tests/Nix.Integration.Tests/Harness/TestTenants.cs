using Nix.Abstractions;
using Nix.Domain.Identity;
using Nix.Domain.Tenancy;

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

    /// <summary>The first tenant's workspace.</summary>
    public static readonly Guid AlphaWorkspace = new("1a1a1a1a-1111-4111-8111-1a1a1a1a1a1a");

    /// <summary>The first tenant's acting principal.</summary>
    public static readonly Guid AlphaPrincipal = new("1b1b1b1b-1111-4111-8111-1b1b1b1b1b1b");

    /// <summary>The second tenant's workspace.</summary>
    public static readonly Guid BetaWorkspace = new("2a2a2a2a-2222-4222-8222-2a2a2a2a2a2a");

    /// <summary>The second tenant's acting principal.</summary>
    public static readonly Guid BetaPrincipal = new("2b2b2b2b-2222-4222-8222-2b2b2b2b2b2b");

    /// <summary>Gets a session context for the first tenant.</summary>
    public static NixSessionContext AlphaContext => ContextFor(Alpha, AlphaWorkspace, AlphaPrincipal);

    /// <summary>Gets a session context for the second tenant.</summary>
    public static NixSessionContext BetaContext => ContextFor(Beta, BetaWorkspace, BetaPrincipal);

    /// <summary>
    /// Wraps raw identifiers into a session context.
    /// </summary>
    /// <param name="tenantId">The tenant.</param>
    /// <param name="workspaceId">The workspace, or <see langword="null"/> for tenant-wide work.</param>
    /// <param name="principalId">The acting principal.</param>
    /// <returns>The context.</returns>
    /// <remarks>
    /// The constants above stay as <see cref="Guid"/> because most assertions compare them against
    /// values read back out of Postgres, where they arrive untyped. This is the one place the
    /// wrapping happens, so a test that transposes two of them still cannot compile.
    /// </remarks>
    public static NixSessionContext ContextFor(Guid tenantId, Guid? workspaceId, Guid principalId) =>
        new(
            TenantId.From(tenantId),
            workspaceId is { } workspace ? WorkspaceId.From(workspace) : null,
            PrincipalId.From(principalId));
}
