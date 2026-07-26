using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata.Builders;
using Nix.Core.Authorization;
using Nix.Core.Items;
using Nix.Infrastructure.Persistence.Conversion;

namespace Nix.Infrastructure.Persistence.Configurations;

/// <summary>
/// Maps <see cref="AclEntry"/> to <c>acl_entry</c>.
/// </summary>
internal sealed class AclEntryConfiguration : IEntityTypeConfiguration<AclEntry>
{
    /// <inheritdoc />
    public void Configure(EntityTypeBuilder<AclEntry> builder)
    {
        ArgumentNullException.ThrowIfNull(builder);

        builder.ToTable(NixTables.AclEntry);

        builder.HasKey(entry => entry.Id);
        builder.Property(entry => entry.Id).HasColumnName("acl_entry_id");
        builder.Property(entry => entry.ItemId).HasColumnName("item_id");
        builder.Property(entry => entry.TenantId).HasColumnName(NixTables.TenantIdColumn);
        builder.Property(entry => entry.WorkspaceId).HasColumnName("workspace_id");

        builder.Property(entry => entry.SubjectType)
            .HasColumnName("subject_type")
            .HasConversion(new EnumConverters.SubjectTypeConverter());

        builder.Property(entry => entry.SubjectId).HasColumnName("subject_id");
        builder.Property(entry => entry.Role).HasColumnName("role").IsRequired();

        builder.Property(entry => entry.Effect)
            .HasColumnName("effect")
            .HasConversion(new EnumConverters.AclEffectConverter());

        builder.Property(entry => entry.BreaksInheritance).HasColumnName("breaks_inheritance");

        builder.HasOne<Item>()
            .WithMany()
            .HasForeignKey(entry => new { entry.TenantId, entry.ItemId })
            .HasPrincipalKey(item => new { item.TenantId, item.Id })

            // Entries die with the item they govern; an orphan entry grants access to nothing and
            // would only ever confuse an audit.
            .OnDelete(DeleteBehavior.Cascade);

        // One entry per subject per item per effect: a subject cannot hold two allows of different
        // roles on one item, which would make "the nearest entry" ambiguous at depth zero.
        builder.HasIndex(entry => new { entry.ItemId, entry.SubjectType, entry.SubjectId, entry.Effect })
            .IsUnique();

        // Resolution joins from the subject side: "every entry that could apply to this principal
        // or their groups", then narrows by closure depth.
        builder.HasIndex(entry => new { entry.TenantId, entry.SubjectType, entry.SubjectId });
    }
}
