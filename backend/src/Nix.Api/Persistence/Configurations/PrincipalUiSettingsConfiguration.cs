using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata.Builders;
using Nix.Domain.Identity;
using Nix.Domain.Settings;

namespace Nix.Persistence.Configurations;

internal sealed class PrincipalUiSettingsConfiguration : IEntityTypeConfiguration<PrincipalUiSettings>
{
    public void Configure(EntityTypeBuilder<PrincipalUiSettings> builder)
    {
        ArgumentNullException.ThrowIfNull(builder);
        builder.ToTable(NixTables.PrincipalUiSettings, table =>
        {
            // The same 16 KiB ceiling the use case enforces, so a writer that bypasses it cannot
            // store an unbounded document, and the document is always an object to merge into.
            table.HasCheckConstraint(
                "principal_ui_settings_bounded",
                "jsonb_typeof(settings) = 'object' AND octet_length(settings::text) <= 16384");
        });
        builder.HasKey(row => new { row.TenantId, row.PrincipalId });
        builder.Property(row => row.TenantId).HasColumnName("tenant_id");
        builder.Property(row => row.PrincipalId).HasColumnName("principal_id");
        builder.Property(row => row.SettingsJson).HasColumnName("settings").HasColumnType("jsonb").HasDefaultValueSql("'{}'::jsonb").IsRequired();
        builder.Property(row => row.Revision).HasColumnName("revision").IsConcurrencyToken();
        builder.HasOne<Principal>().WithMany()
            .HasForeignKey(row => new { row.TenantId, row.PrincipalId })
            .HasPrincipalKey(row => new { row.TenantId, row.Id })
            .OnDelete(DeleteBehavior.Cascade);
    }
}
