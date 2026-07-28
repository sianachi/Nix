using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata.Builders;
using Nix.Domain.Identity;
using Nix.Domain.Tenancy;
using Nix.Persistence.Conversion;

namespace Nix.Persistence.Configurations;

/// <summary>
/// Maps <see cref="Principal"/> to <c>principal</c>.
/// </summary>
internal sealed class PrincipalConfiguration : IEntityTypeConfiguration<Principal>
{
    /// <inheritdoc />
    public void Configure(EntityTypeBuilder<Principal> builder)
    {
        ArgumentNullException.ThrowIfNull(builder);

        builder.ToTable(NixTables.Principal);

        builder.HasKey(principal => principal.Id);
        builder.Property(principal => principal.Id).HasColumnName("principal_id");
        builder.Property(principal => principal.TenantId).HasColumnName(NixTables.TenantIdColumn);

        builder.Property(principal => principal.ExternalSubject).HasColumnName("external_subject").IsRequired();

        builder.Property(principal => principal.Kind)
            .HasColumnName("kind")
            .HasConversion(new EnumConverters.PrincipalKindConverter())
            .IsRequired();

        builder.Property(principal => principal.DisplayName).HasColumnName("display_name").IsRequired();
        builder.Property(principal => principal.Email).HasColumnName("email");

        builder.Property(principal => principal.Status)
            .HasColumnName("status")
            .HasConversion(new EnumConverters.PrincipalStatusConverter())
            .IsRequired();

        builder.Property(principal => principal.DeprovisionedAt).HasColumnName("deprovisioned_at");

        // The target of every composite tenant-scoped reference to a principal.
        builder.HasAlternateKey(principal => new { principal.TenantId, principal.Id });

        builder.HasOne<Tenant>()
            .WithMany()
            .HasForeignKey(principal => principal.TenantId)
            .OnDelete(DeleteBehavior.Restrict);

        // One row per subject per tenant. Note for the authentication goal: this is unique on the
        // subject alone, not on (provider, subject). A tenant that registers two issuers which
        // both mint the subject "1234" would collide here. Whether that is prevented by adding
        // provider_id to this key or by requiring globally unique subjects is authentication's
        // call to make, with the token-validation code in front of it - the schema should not
        // guess now and have the resolver work around it later.
        builder.HasIndex(principal => new { principal.TenantId, principal.ExternalSubject }).IsUnique();
    }
}
