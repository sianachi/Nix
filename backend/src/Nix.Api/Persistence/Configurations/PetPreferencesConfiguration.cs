using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata.Builders;
using Nix.Domain.Content;
using Nix.Domain.Identity;

namespace Nix.Persistence.Configurations;

internal sealed class PetPreferencesConfiguration : IEntityTypeConfiguration<PetPreferences>
{
    public void Configure(EntityTypeBuilder<PetPreferences> builder)
    {
        ArgumentNullException.ThrowIfNull(builder);
        builder.ToTable(NixTables.PetPreferences, table => table.HasCheckConstraint("pet_preferences_bounded", "octet_length(settings::text) <= 65536 AND revision > 0"));
        builder.HasKey(row => new { row.TenantId, row.PrincipalId });
        builder.Property(row => row.TenantId).HasColumnName("tenant_id");
        builder.Property(row => row.PrincipalId).HasColumnName("principal_id");
        builder.Property(row => row.SettingsJson).HasColumnName("settings").HasColumnType("jsonb");
        builder.Property(row => row.Revision).HasColumnName("revision").IsConcurrencyToken();
        builder.HasOne<Principal>().WithMany()
            .HasForeignKey(row => new { row.TenantId, row.PrincipalId })
            .HasPrincipalKey(row => new { row.TenantId, row.Id })
            .OnDelete(DeleteBehavior.Cascade);
    }
}
