using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata.Builders;
using Nix.Core.Identity;
using Nix.Core.Tenancy;
using Nix.Infrastructure.Persistence.Conversion;

namespace Nix.Infrastructure.Persistence.Configurations;

/// <summary>
/// Maps <see cref="WorkspaceMember"/> to <c>workspace_member</c>.
/// </summary>
internal sealed class WorkspaceMemberConfiguration : IEntityTypeConfiguration<WorkspaceMember>
{
    /// <inheritdoc />
    public void Configure(EntityTypeBuilder<WorkspaceMember> builder)
    {
        ArgumentNullException.ThrowIfNull(builder);

        builder.ToTable(NixTables.WorkspaceMember);

        builder.HasKey(member => new { member.WorkspaceId, member.SubjectType, member.SubjectId });

        builder.Property(member => member.WorkspaceId).HasColumnName("workspace_id");
        builder.Property(member => member.TenantId).HasColumnName(NixTables.TenantIdColumn);

        builder.Property(member => member.SubjectType)
            .HasColumnName("subject_type")
            .HasConversion(new EnumConverters.SubjectTypeConverter());

        builder.Property(member => member.SubjectId).HasColumnName("subject_id");
        builder.Property(member => member.Role).HasColumnName("role").IsRequired();
        builder.Property(member => member.GrantedBy).HasColumnName("granted_by");
        builder.Property(member => member.GrantedAt).HasColumnName("granted_at");

        builder.HasOne<Workspace>()
            .WithMany()
            .HasForeignKey(member => new { member.TenantId, member.WorkspaceId })
            .HasPrincipalKey(workspace => new { workspace.TenantId, workspace.Id })
            .OnDelete(DeleteBehavior.Cascade);

        // The chain-root allow is looked up per subject during resolution, not per workspace.
        builder.HasIndex(member => new { member.TenantId, member.SubjectType, member.SubjectId });
    }
}
