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
        builder.Property(principal => principal.ExternalIssuer).HasColumnName("external_issuer");

        builder.Property(principal => principal.Kind)
            .HasColumnName("kind")
            .HasConversion(new EnumConverters.PrincipalKindConverter())
            .IsRequired();

        builder.Property(principal => principal.DisplayName).HasColumnName("display_name").IsRequired();
        builder.Property(principal => principal.Email).HasColumnName("email");
        builder.Property(principal => principal.EmailNormalized).HasColumnName("email_normalized");
        builder.Property(principal => principal.EmailVerified)
            .HasColumnName("email_verified")
            .HasDefaultValue(false)
            .IsRequired();

        builder.Property(principal => principal.Status)
            .HasColumnName("status")
            .HasConversion(new EnumConverters.PrincipalStatusConverter())
            .IsRequired();

        builder.Property(principal => principal.DeprovisionedAt).HasColumnName("deprovisioned_at");
        builder.Property(principal => principal.CanManageTemplates)
            .HasColumnName("can_manage_templates")
            .HasDefaultValue(false);

        // The target of every composite tenant-scoped reference to a principal.
        builder.HasAlternateKey(principal => new { principal.TenantId, principal.Id });

        builder.HasOne<Tenant>()
            .WithMany()
            .HasForeignKey(principal => principal.TenantId)
            .OnDelete(DeleteBehavior.Restrict);

        builder.HasIndex(principal => new
        {
            principal.TenantId,
            principal.ExternalIssuer,
            principal.ExternalSubject,
        })
            .IsUnique()
            .HasFilter("external_issuer IS NOT NULL");

        builder.HasIndex(principal => new { principal.TenantId, principal.EmailNormalized })
            .HasFilter("kind = 'user' AND status = 'active' AND email_verified AND email_normalized IS NOT NULL");

        builder.HasIndex(principal => new { principal.TenantId, principal.Id })
            .HasDatabaseName("ix_principal_workspace_invitee")
            .HasFilter("kind = 'user' AND status = 'active' AND email_verified AND email_normalized IS NOT NULL AND email IS NOT NULL")
            .IncludeProperties(principal => new { principal.DisplayName, principal.Email });
    }
}
