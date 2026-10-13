using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.ChangeTracking;
using Microsoft.EntityFrameworkCore.Metadata.Builders;
using Nix.Domain.Identity;
using Nix.Domain.Workspaces;

namespace Nix.Persistence.Configurations;

internal sealed class WorkspaceArrangementConfiguration : IEntityTypeConfiguration<WorkspaceArrangement>
{
    public void Configure(EntityTypeBuilder<WorkspaceArrangement> builder)
    {
        ArgumentNullException.ThrowIfNull(builder);
        builder.ToTable(NixTables.WorkspaceArrangement, table =>
        {
            // The same ceilings the use case enforces, so a writer that bypasses it cannot store an
            // unbounded document: 200 pins, and a groups document under 64 KiB.
            table.HasCheckConstraint(
                "workspace_arrangement_bounded",
                "(array_length(pinned_workspace_ids, 1) IS NULL OR array_length(pinned_workspace_ids, 1) <= 200) AND octet_length(groups_json::text) <= 65536");
        });
        builder.HasKey(row => new { row.TenantId, row.PrincipalId });
        builder.Property(row => row.TenantId).HasColumnName("tenant_id");
        builder.Property(row => row.PrincipalId).HasColumnName("principal_id");
        builder.Property(row => row.GroupsJson).HasColumnName("groups_json").HasColumnType("jsonb").IsRequired();
        builder.Property(row => row.PinnedWorkspaceIds)
            .HasColumnName("pinned_workspace_ids")
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
