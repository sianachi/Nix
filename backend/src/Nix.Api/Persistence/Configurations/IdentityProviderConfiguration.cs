using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.ChangeTracking;
using Microsoft.EntityFrameworkCore.Metadata.Builders;
using Nix.Domain.Identity;
using Nix.Domain.Tenancy;

namespace Nix.Persistence.Configurations;

/// <summary>
/// Maps <see cref="IdentityProvider"/> to <c>identity_provider</c>.
/// </summary>
internal sealed class IdentityProviderConfiguration : IEntityTypeConfiguration<IdentityProvider>
{
    /// <inheritdoc />
    public void Configure(EntityTypeBuilder<IdentityProvider> builder)
    {
        ArgumentNullException.ThrowIfNull(builder);

        builder.ToTable(NixTables.IdentityProvider);

        builder.HasKey(provider => provider.Id);
        builder.Property(provider => provider.Id).HasColumnName("provider_id");
        builder.Property(provider => provider.TenantId).HasColumnName(NixTables.TenantIdColumn);

        builder.Property(provider => provider.Issuer).HasColumnName("issuer").IsRequired();
        builder.Property(provider => provider.Audience).HasColumnName("audience").IsRequired();

        builder.Property(provider => provider.JwksUri)
            .HasColumnName("jwks_uri")
            .HasConversion(uri => uri.AbsoluteUri, value => new Uri(value, UriKind.Absolute))
            .IsRequired();

        // text[] rather than a delimited string: an allowlist is a set, and storing it as one
        // means "which issuers still accept RS256" is a query instead of a scan-and-split.
        //
        // The comparer is required because the domain type is a read-only list, which EF cannot
        // snapshot structurally on its own; without one it would compare by reference and miss
        // every edit. Change tracking is off by default, so this runs only where a caller has
        // opted into it.
        builder.Property(provider => provider.AllowedAlgorithms)
            .HasColumnName("allowed_algorithms")
            .HasColumnType("text[]")
            .HasConversion(
                algorithms => algorithms.ToArray(),
                stored => (IReadOnlyList<string>)stored,
                new ValueComparer<IReadOnlyList<string>>(
                    (left, right) => left != null && right != null && left.SequenceEqual(right),
                    algorithms => algorithms.Aggregate(
                        0,
                        (hash, algorithm) => HashCode.Combine(hash, algorithm.GetHashCode(StringComparison.Ordinal))),
                    algorithms => algorithms.ToArray()))
            .IsRequired();

        builder.Property(provider => provider.Enabled).HasColumnName("enabled").IsRequired();

        builder.HasOne<Tenant>()
            .WithMany()
            .HasForeignKey(provider => provider.TenantId)
            .OnDelete(DeleteBehavior.Restrict);

        // Issuer and audience together resolve a token to exactly one tenant, so the pair is
        // unique across the whole table rather than within a tenant. Two tenants registering the
        // same pair would make that resolution ambiguous, and the safe response to an ambiguous
        // token is to have made the registration impossible rather than to pick one.
        builder.HasIndex(provider => new { provider.Issuer, provider.Audience }).IsUnique();

        builder.HasIndex(provider => provider.TenantId);
    }
}
