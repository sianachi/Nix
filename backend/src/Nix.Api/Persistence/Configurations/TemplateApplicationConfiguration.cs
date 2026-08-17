using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata.Builders;
using Nix.Domain.Items;
using Nix.Domain.Templates;
using Nix.Domain.Tenancy;
using Nix.Persistence.Conversion;

namespace Nix.Persistence.Configurations;

/// <summary>Maps idempotent template applications.</summary>
internal sealed class TemplateApplicationConfiguration : IEntityTypeConfiguration<TemplateApplication>
{
    /// <inheritdoc />
    public void Configure(EntityTypeBuilder<TemplateApplication> builder)
    {
        ArgumentNullException.ThrowIfNull(builder);

        builder.ToTable(NixTables.TemplateApplication);
        builder.HasKey(application => application.Id);
        builder.Property(application => application.Id).HasColumnName("application_id");
        builder.Property(application => application.TenantId).HasColumnName(NixTables.TenantIdColumn);
        builder.Property(application => application.WorkspaceId).HasColumnName("workspace_id");
        builder.Property(application => application.TemplateId).HasColumnName("template_id");
        builder.Property(application => application.TargetItemId).HasColumnName("target_item_id");
        builder.Property(application => application.ParentItemId).HasColumnName("parent_item_id");
        builder.Property(application => application.RequestedTitle).HasColumnName("requested_title").HasMaxLength(200);
        builder.Property(application => application.Mode)
            .HasColumnName("mode")
            .HasConversion(new EnumConverters.TemplateApplicationModeConverter());
        builder.Property(application => application.IdempotencyKey).HasColumnName("idempotency_key").HasMaxLength(160);
        builder.Property(application => application.ActorId).HasColumnName("actor_id");
        builder.Property(application => application.State)
            .HasColumnName("state")
            .HasConversion(new EnumConverters.TemplateOperationStateConverter());
        builder.Property(application => application.CreatedAt).HasColumnName("created_at");
        builder.Property(application => application.ExpiresAt).HasColumnName("expires_at");
        builder.Property(application => application.FinalizedAt).HasColumnName("finalized_at");

        builder.HasAlternateKey(application => new { application.TenantId, application.Id });
        builder.HasIndex(application => new { application.TenantId, application.ActorId, application.IdempotencyKey })
            .IsUnique();
        builder.HasIndex(application => new { application.TemplateId, application.TargetItemId });
        builder.HasIndex(application => new
        {
            application.TenantId,
            application.WorkspaceId,
            application.State,
            application.ExpiresAt,
        });

        builder.HasOne<WorkspaceTemplate>()
            .WithMany()
            .HasForeignKey(application => new { application.TenantId, application.TemplateId })
            .HasPrincipalKey(template => new { template.TenantId, template.Id })
            .OnDelete(DeleteBehavior.Restrict);

        builder.HasOne<Workspace>()
            .WithMany()
            .HasForeignKey(application => new { application.TenantId, application.WorkspaceId })
            .HasPrincipalKey(workspace => new { workspace.TenantId, workspace.Id })
            .OnDelete(DeleteBehavior.Cascade);
    }
}
