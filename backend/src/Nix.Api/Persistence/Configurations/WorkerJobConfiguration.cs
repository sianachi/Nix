using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata.Builders;
using Nix.Domain.Workers;

namespace Nix.Persistence.Configurations;

/// <summary>Maps durable worker jobs.</summary>
internal sealed class WorkerJobConfiguration : IEntityTypeConfiguration<WorkerJob>
{
    /// <inheritdoc />
    public void Configure(EntityTypeBuilder<WorkerJob> builder)
    {
        ArgumentNullException.ThrowIfNull(builder);
        builder.ToTable(NixTables.WorkerJob);
        builder.HasKey(job => job.Id);
        builder.Property(job => job.Id).HasColumnName("job_id");
        builder.Property(job => job.TenantId).HasColumnName(NixTables.TenantIdColumn);
        builder.Property(job => job.WorkspaceId).HasColumnName("workspace_id");
        builder.Property(job => job.ActorId).HasColumnName("actor_id");
        builder.Property(job => job.Kind).HasColumnName("kind").HasMaxLength(64);
        builder.Property(job => job.IdempotencyKey).HasColumnName("idempotency_key").HasMaxLength(160);
        builder.Property(job => job.Payload).HasColumnName("payload").HasColumnType("jsonb");
        builder.Property(job => job.Status).HasColumnName("status").HasMaxLength(32);
        builder.Property(job => job.Result).HasColumnName("result").HasColumnType("jsonb");
        builder.Property(job => job.ErrorCode).HasColumnName("error_code").HasMaxLength(64);
        builder.Property(job => job.ErrorDetail).HasColumnName("error_detail").HasMaxLength(2000);
        builder.Property(job => job.Attempts).HasColumnName("attempts");
        builder.Property(job => job.LeaseOwner).HasColumnName("lease_owner").HasMaxLength(128);
        builder.Property(job => job.LeaseUntil).HasColumnName("lease_until");
        builder.Property(job => job.CancellationRequested).HasColumnName("cancellation_requested");
        builder.Property(job => job.StartedAt).HasColumnName("started_at");
        builder.Property(job => job.CompletedAt).HasColumnName("completed_at");
        builder.Property(job => job.CreatedAt).HasColumnName("created_at");
        builder.Property(job => job.UpdatedAt).HasColumnName("updated_at");
        builder.HasAlternateKey(job => new { job.TenantId, job.Id });
        builder.HasIndex(job => new { job.TenantId, job.ActorId, job.IdempotencyKey }).IsUnique();
        builder.HasIndex(job => new { job.Status, job.LeaseUntil, job.CreatedAt });
        builder.HasOne<Nix.Domain.Tenancy.Workspace>().WithMany()
            .HasForeignKey(job => new { job.TenantId, job.WorkspaceId })
            .HasPrincipalKey(workspace => new { workspace.TenantId, workspace.Id })
            .OnDelete(DeleteBehavior.Cascade);
    }
}
