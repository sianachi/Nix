using Nix.Domain.Identity;
using Nix.Domain.Tenancy;

namespace Nix.Domain.Plugins;

#pragma warning disable CA1819 // Justification: EF Core's PostgreSQL bytea provider requires byte[] storage for the fixed 32-byte key.

/// <summary>A tenant-pinned publisher identity whose signing key cannot be rotated implicitly.</summary>
public sealed class PluginPublisher
{
    /// <summary>Gets the tenant that pinned this publisher.</summary>
    public required TenantId TenantId { get; init; }

    /// <summary>Gets the stable publisher namespace.</summary>
    public required string Id { get; init; }

    /// <summary>Gets the pinned 32-byte Ed25519 public key.</summary>
    public required byte[] Ed25519PublicKey { get; init; }

    /// <summary>Gets who accepted the first key for this publisher in the tenant.</summary>
    public required PrincipalId PinnedBy { get; init; }

    /// <summary>Gets when the key was pinned.</summary>
    public required DateTimeOffset PinnedAt { get; init; }
}
#pragma warning restore CA1819
