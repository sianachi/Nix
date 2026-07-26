using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata.Builders;
using Nix.Core.Identity;
using Nix.Core.Tenancy;

namespace Nix.Infrastructure.Persistence.Configurations;

/// <summary>
/// Maps <see cref="PrincipalGroup"/> to <c>principal_group</c>.
/// </summary>
internal sealed class PrincipalGroupConfiguration : IEntityTypeConfiguration<PrincipalGroup>
{
    /// <inheritdoc />
    public void Configure(EntityTypeBuilder<PrincipalGroup> builder)
    {
        ArgumentNullException.ThrowIfNull(builder);

        builder.ToTable(NixTables.PrincipalGroup);

        builder.HasKey(group => group.Id);
        builder.Property(group => group.Id).HasColumnName("group_id");
        builder.Property(group => group.TenantId).HasColumnName(NixTables.TenantIdColumn);

        builder.Property(group => group.Name).HasColumnName("name").IsRequired();
        builder.Property(group => group.ExternalId).HasColumnName("external_id");

        builder.HasAlternateKey(group => new { group.TenantId, group.Id });

        builder.HasOne<Tenant>()
            .WithMany()
            .HasForeignKey(group => group.TenantId)
            .OnDelete(DeleteBehavior.Restrict);

        // Filtered: groups created in Nix have no external id, and several such rows must not
        // collide with each other on NULL.
        builder.HasIndex(group => new { group.TenantId, group.ExternalId })
            .IsUnique()
            .HasFilter("external_id IS NOT NULL");
    }
}
