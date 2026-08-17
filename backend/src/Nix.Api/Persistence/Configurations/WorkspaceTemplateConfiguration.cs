using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata.Builders;
using Nix.Domain.Items;
using Nix.Domain.Templates;
using Nix.Domain.Tenancy;
using Nix.Persistence.Conversion;

namespace Nix.Persistence.Configurations;

/// <summary>Maps the workspace template catalog.</summary>
internal sealed class WorkspaceTemplateConfiguration : IEntityTypeConfiguration<WorkspaceTemplate>
{
    /// <inheritdoc />
    public void Configure(EntityTypeBuilder<WorkspaceTemplate> builder)
    {
        ArgumentNullException.ThrowIfNull(builder);

        builder.ToTable(NixTables.WorkspaceTemplate);
        builder.HasKey(template => template.Id);
        builder.Property(template => template.Id).HasColumnName("template_id");
        builder.Property(template => template.TenantId).HasColumnName(NixTables.TenantIdColumn);
        builder.Property(template => template.WorkspaceId).HasColumnName("workspace_id");
        builder.Property(template => template.RootItemId).HasColumnName("root_item_id");
        builder.Property(template => template.PendingRootItemId).HasColumnName("pending_root_item_id");
        builder.Property(template => template.StableKey).HasColumnName("stable_key").HasMaxLength(160);
        builder.Property(template => template.ProfileKey).HasColumnName("profile_key").HasMaxLength(160);
        builder.Property(template => template.Origin)
            .HasColumnName("origin")
            .HasConversion(new EnumConverters.TemplateOriginConverter());
        builder.Property(template => template.Title).HasColumnName("title").HasMaxLength(200);
        builder.Property(template => template.Description).HasColumnName("description").HasMaxLength(1000);
        builder.Property(template => template.IncludeBody).HasColumnName("include_body");
        builder.Property(template => template.IncludeChildren).HasColumnName("include_children");
        builder.Property(template => template.ManagedSource).HasColumnName("managed_source").HasMaxLength(500);
        builder.Property(template => template.SourceDigest).HasColumnName("source_digest").HasMaxLength(128);
        builder.Property(template => template.State)
            .HasColumnName("state")
            .HasConversion(new EnumConverters.TemplateStateConverter());
        builder.Property(template => template.Revision).HasColumnName("revision");
        builder.Property(template => template.CreatedBy).HasColumnName("created_by");
        builder.Property(template => template.LastModifiedBy).HasColumnName("last_modified_by");
        builder.Property(template => template.CreatedAt).HasColumnName("created_at");
        builder.Property(template => template.LastModifiedAt).HasColumnName("last_modified_at");

        builder.HasAlternateKey(template => new { template.TenantId, template.Id });
        builder.HasIndex(template => new { template.TenantId, template.WorkspaceId, template.StableKey }).IsUnique();
        builder.HasIndex(template => new { template.WorkspaceId, template.State, template.LastModifiedAt });

        builder.HasOne<Workspace>()
            .WithMany()
            .HasForeignKey(template => new { template.TenantId, template.WorkspaceId })
            .HasPrincipalKey(workspace => new { workspace.TenantId, workspace.Id })
            .OnDelete(DeleteBehavior.Cascade);

        // Root pointers are validated and swapped by TemplateStore, not foreign keys. A reverse
        // item -> catalog FK already owns the hidden envelopes; adding the two opposite FKs makes
        // a cycle that blocks bounded cleanup and requires superuser trigger disabling to reset.
    }
}
