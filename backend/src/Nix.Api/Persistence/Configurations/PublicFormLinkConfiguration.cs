using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata.Builders;
using Nix.Domain.Identity;
using Nix.Domain.Items;
using Nix.Domain.Tenancy;
using Nix.Domain.Views;

namespace Nix.Persistence.Configurations;

internal sealed class PublicFormLinkConfiguration : IEntityTypeConfiguration<PublicFormLink>
{
    public void Configure(EntityTypeBuilder<PublicFormLink> builder)
    {
        builder.ToTable(NixTables.PublicFormLink);
        builder.HasKey(link => link.Id);
        builder.Property(link => link.Id).HasColumnName("id");
        builder.Property(link => link.TenantId).HasColumnName(NixTables.TenantIdColumn);
        builder.Property(link => link.WorkspaceId).HasColumnName("workspace_id");
        builder.Property(link => link.ItemId).HasColumnName("item_id");
        builder.Property(link => link.ViewId).HasColumnName("view_id").HasMaxLength(128);
        builder.Property(link => link.Nonce).HasColumnName("nonce").HasMaxLength(64);
        builder.Property(link => link.SubmissionPrincipalId).HasColumnName("submission_principal_id");
        builder.Property(link => link.PublishedBy).HasColumnName("published_by");
        builder.Property(link => link.PublishedAt).HasColumnName("published_at");
        builder.Property(link => link.RevokedAt).HasColumnName("revoked_at");
        builder.HasIndex(link => new { link.TenantId, link.ItemId, link.ViewId }).IsUnique();

        builder.HasOne<Tenant>()
            .WithMany()
            .HasForeignKey(link => link.TenantId)
            .OnDelete(DeleteBehavior.Restrict);
        builder.HasOne<Workspace>()
            .WithMany()
            .HasForeignKey(link => new { link.TenantId, link.WorkspaceId })
            .HasPrincipalKey(workspace => new { workspace.TenantId, workspace.Id })
            .OnDelete(DeleteBehavior.Cascade);
        builder.HasOne<Item>()
            .WithMany()
            .HasForeignKey(link => new { link.TenantId, link.ItemId })
            .HasPrincipalKey(item => new { item.TenantId, item.Id })
            .OnDelete(DeleteBehavior.Cascade);
        builder.HasOne<Principal>()
            .WithMany()
            .HasForeignKey(link => new { link.TenantId, link.SubmissionPrincipalId })
            .HasPrincipalKey(principal => new { principal.TenantId, principal.Id })
            .OnDelete(DeleteBehavior.Restrict);
        builder.HasOne<Principal>()
            .WithMany()
            .HasForeignKey(link => new { link.TenantId, link.PublishedBy })
            .HasPrincipalKey(principal => new { principal.TenantId, principal.Id })
            .OnDelete(DeleteBehavior.Restrict);
    }
}
