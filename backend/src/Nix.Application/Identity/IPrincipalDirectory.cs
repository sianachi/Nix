using Nix.Core.Identity;

namespace Nix.Application.Identity;

/// <summary>
/// Reads principals inside an established tenant scope.
/// </summary>
/// <remarks>
/// <para>
/// Deliberately separate from <see cref="IIdentityDirectory"/>, which exists precisely because its
/// two lookups happen <i>before</i> a tenant is known and must therefore go through a
/// security-definer function that steps around the isolation policies. This port is the ordinary
/// case: the tenant is established, row-level security applies, and a principal from another tenant
/// is not merely refused but invisible. Putting both behind one interface would put those two very
/// different security postures behind one name.
/// </para>
/// <para>
/// A port because the dependency direction requires one - use cases live in this assembly and the
/// implementation needs EF Core, which only Infrastructure may reference.
/// </para>
/// </remarks>
public interface IPrincipalDirectory
{
    /// <summary>Finds a principal in the current tenant.</summary>
    /// <param name="id">The principal.</param>
    /// <param name="cancellationToken">Cancels the read.</param>
    /// <returns>The principal, or <see langword="null"/> when they are not visible.</returns>
    public ValueTask<Principal?> FindAsync(PrincipalId id, CancellationToken cancellationToken);
}
