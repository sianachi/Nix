using Nix.Domain.Identity;
using Nix.Domain.Tenancy;

namespace Nix.Domain.Plugins;

#pragma warning disable CA1819 // Justification: EF Core's PostgreSQL bytea provider requires byte[] storage for the fixed 64-byte signature.

/// <summary>One immutable signed WebAssembly component version.</summary>
public sealed class PluginComponent
{
    /// <summary>Gets the owning tenant.</summary>
    public required TenantId TenantId { get; init; }

    /// <summary>Gets the publisher whose pinned key signs this component.</summary>
    public required string PublisherId { get; init; }

    /// <summary>Gets the publisher-qualified component identity.</summary>
    public required string Id { get; init; }

    /// <summary>Gets the exact semantic version.</summary>
    public required string Version { get; init; }

    /// <summary>Gets the immutable private-object key.</summary>
    public required string ObjectKey { get; init; }

    /// <summary>Gets the uppercase SHA-256 digest of the component bytes.</summary>
    public required string Sha256 { get; init; }

    /// <summary>Gets the exact component byte length.</summary>
    public required long ByteLength { get; init; }

    /// <summary>Gets the 64-byte Ed25519 signature over the canonical identity, version, and digest.</summary>
    public required byte[] Ed25519Signature { get; init; }

    /// <summary>Gets who registered this immutable version.</summary>
    public required PrincipalId RegisteredBy { get; init; }

    /// <summary>Gets when this immutable version was registered.</summary>
    public required DateTimeOffset RegisteredAt { get; init; }
}
#pragma warning restore CA1819
