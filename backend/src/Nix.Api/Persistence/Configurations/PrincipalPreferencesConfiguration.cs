using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.ChangeTracking;
using Microsoft.EntityFrameworkCore.Metadata.Builders;
using Nix.Domain.Identity;
using Nix.Domain.Notifications;

namespace Nix.Persistence.Configurations;

internal sealed class PrincipalPreferencesConfiguration : IEntityTypeConfiguration<PrincipalPreferences>
{
    public void Configure(EntityTypeBuilder<PrincipalPreferences> builder)
    {
        ArgumentNullException.ThrowIfNull(builder);
        builder.ToTable(NixTables.PrincipalPreferences, table =>
        {
            table.HasCheckConstraint(
                "principal_preferences_bounded",
                "array_length(muted_container_ids, 1) IS NULL OR array_length(muted_container_ids, 1) <= 200");

            // Quiet hours are a window: both ends or neither, never half of one for the planner to guess at.
            table.HasCheckConstraint("principal_preferences_quiet_hours", "(quiet_start IS NULL) = (quiet_end IS NULL)");
        });
        builder.HasKey(row => new { row.TenantId, row.PrincipalId });
        builder.Property(row => row.TenantId).HasColumnName("tenant_id");
        builder.Property(row => row.PrincipalId).HasColumnName("principal_id");
        builder.Property(row => row.TimeZone).HasColumnName("time_zone").HasMaxLength(64).IsRequired();
        builder.Property(row => row.QuietStart).HasColumnName("quiet_start");
        builder.Property(row => row.QuietEnd).HasColumnName("quiet_end");
        builder.Property(row => row.DueReminderTime).HasColumnName("due_reminder_time");
        builder.Property(row => row.DueReminders).HasColumnName("due_reminders");
        builder.Property(row => row.HabitReminders).HasColumnName("habit_reminders");
        builder.Property(row => row.MutedContainerIds)
            .HasColumnName("muted_container_ids")
            .HasColumnType("uuid[]")
            .HasConversion(
                ids => ids.ToArray(),
                stored => (IReadOnlyList<Guid>)stored,
                new ValueComparer<IReadOnlyList<Guid>>(
                    (left, right) => left != null && right != null && left.SequenceEqual(right),
                    ids => ids.Aggregate(0, (hash, id) => HashCode.Combine(hash, id)),
                    ids => ids.ToArray()))
            .IsRequired();
        builder.Property(row => row.Revision).HasColumnName("revision").IsConcurrencyToken();
        builder.HasOne<Principal>().WithMany()
            .HasForeignKey(row => new { row.TenantId, row.PrincipalId })
            .HasPrincipalKey(row => new { row.TenantId, row.Id })
            .OnDelete(DeleteBehavior.Cascade);
    }
}
