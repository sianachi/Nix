using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata.Builders;
using Nix.Domain.Identity;
using Nix.Domain.Tenancy;
using Nix.Persistence.Conversion;

namespace Nix.Persistence.Configurations;

/// <summary>Maps durable workspace invitation history.</summary>
internal sealed class WorkspaceInvitationConfiguration : IEntityTypeConfiguration<WorkspaceInvitation>
{
    /// <inheritdoc />
    public void Configure(EntityTypeBuilder<WorkspaceInvitation> builder)
    {
        ArgumentNullException.ThrowIfNull(builder);

        builder.ToTable(NixTables.WorkspaceInvitation);
        builder.HasKey(invitation => invitation.Id);
        builder.Property(invitation => invitation.Id).HasColumnName("invitation_id");
        builder.Property(invitation => invitation.TenantId).HasColumnName(NixTables.TenantIdColumn);
        builder.Property(invitation => invitation.WorkspaceId).HasColumnName("workspace_id");
        builder.Property(invitation => invitation.EmailNormalized)
            .HasColumnName("email_normalized")
            .HasMaxLength(EmailAddressNormalizer.MaximumUtf8ByteLength)
            .IsRequired();
        builder.Property(invitation => invitation.TargetPrincipalId)
            .HasColumnName("target_principal_id");
        builder.Property(invitation => invitation.Role).HasColumnName("role").IsRequired();
        builder.Property(invitation => invitation.InvitedByPrincipalId)
            .HasColumnName("invited_by_principal_id");
        builder.Property(invitation => invitation.Status)
            .HasColumnName("status")
            .HasConversion(new EnumConverters.WorkspaceInvitationStatusConverter())
            .IsRequired();
        builder.Property(invitation => invitation.InvitedAt).HasColumnName("invited_at");
        builder.Property(invitation => invitation.AcceptedAt).HasColumnName("accepted_at");
        builder.Property(invitation => invitation.AcceptedByPrincipalId)
            .HasColumnName("accepted_by_principal_id");
        builder.Property(invitation => invitation.RevokedAt).HasColumnName("revoked_at");

        builder.HasOne<Workspace>()
            .WithMany()
            .HasForeignKey(invitation => new { invitation.TenantId, invitation.WorkspaceId })
            .HasPrincipalKey(workspace => new { workspace.TenantId, workspace.Id })
            .OnDelete(DeleteBehavior.Restrict);
        builder.HasOne<Principal>()
            .WithMany()
            .HasForeignKey(invitation => new { invitation.TenantId, invitation.InvitedByPrincipalId })
            .HasPrincipalKey(principal => new { principal.TenantId, principal.Id })
            .OnDelete(DeleteBehavior.Restrict);
        builder.HasOne<Principal>()
            .WithMany()
            .HasForeignKey(invitation => new { invitation.TenantId, invitation.AcceptedByPrincipalId })
            .HasPrincipalKey(principal => new { principal.TenantId, principal.Id })
            .OnDelete(DeleteBehavior.Restrict);
        builder.HasOne<Principal>()
            .WithMany()
            .HasForeignKey(invitation => new { invitation.TenantId, invitation.TargetPrincipalId })
            .HasPrincipalKey(principal => new { principal.TenantId, principal.Id })
            .OnDelete(DeleteBehavior.Restrict);

        builder.HasIndex(invitation => new
        {
            invitation.TenantId,
            invitation.WorkspaceId,
            invitation.EmailNormalized,
        })
            .IsUnique()
            .HasFilter("status = 'pending'")
            .HasDatabaseName("ix_workspace_invitation_pending_unique");
        builder.HasIndex(invitation => new
        {
            invitation.TenantId,
            invitation.WorkspaceId,
            invitation.TargetPrincipalId,
        })
            .IsUnique()
            .HasFilter("status = 'pending' AND target_principal_id IS NOT NULL")
            .HasDatabaseName("ix_workspace_invitation_pending_target");
        builder.HasIndex(invitation => new
        {
            invitation.TenantId,
            invitation.EmailNormalized,
            invitation.InvitedAt,
            invitation.Id,
        })
            .HasFilter("status = 'pending'")
            .HasDatabaseName("ix_workspace_invitation_redemption");
        builder.HasIndex(invitation => new
        {
            invitation.TenantId,
            invitation.WorkspaceId,
            invitation.InvitedAt,
            invitation.Id,
        })
            .IsDescending(false, false, true, true)
            .HasDatabaseName("ix_workspace_invitation_history");
    }
}
