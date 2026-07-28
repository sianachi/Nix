using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata.Builders;
using Nix.Domain.Identity;
using Nix.Domain.Tenancy;
using Nix.Persistence.Conversion;

namespace Nix.Persistence.Configurations;

/// <summary>
/// Maps <see cref="TenantRoleGrant"/> to <c>tenant_role</c>.
/// </summary>
/// <remarks>
/// <c>subject_id</c> carries no foreign key. It points at a principal or a group depending on
/// <c>subject_type</c>, and a column cannot reference two tables. The alternative - one nullable
/// column per subject kind - trades a checkable constraint for two columns that must be kept
/// mutually exclusive by code, which is not obviously better and is certainly wordier.
/// </remarks>
internal sealed class TenantRoleGrantConfiguration : IEntityTypeConfiguration<TenantRoleGrant>
{
    /// <inheritdoc />
    public void Configure(EntityTypeBuilder<TenantRoleGrant> builder)
    {
        ArgumentNullException.ThrowIfNull(builder);

        builder.ToTable(NixTables.TenantRole);

        builder.HasKey(grant => new { grant.TenantId, grant.SubjectType, grant.SubjectId });

        builder.Property(grant => grant.TenantId).HasColumnName(NixTables.TenantIdColumn);

        builder.Property(grant => grant.SubjectType)
            .HasColumnName("subject_type")
            .HasConversion(new EnumConverters.SubjectTypeConverter());

        builder.Property(grant => grant.SubjectId).HasColumnName("subject_id");
        builder.Property(grant => grant.Role).HasColumnName("role").IsRequired();
        builder.Property(grant => grant.GrantedBy).HasColumnName("granted_by");
        builder.Property(grant => grant.GrantedAt).HasColumnName("granted_at");

        builder.HasOne<Tenant>()
            .WithMany()
            .HasForeignKey(grant => grant.TenantId)
            .OnDelete(DeleteBehavior.Restrict);
    }
}
