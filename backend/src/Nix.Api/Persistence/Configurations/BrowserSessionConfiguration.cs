using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata.Builders;
using Nix.Domain.Identity;

namespace Nix.Persistence.Configurations;

/// <summary>Maps <see cref="BrowserSession"/> to <c>browser_session</c>.</summary>
internal sealed class BrowserSessionConfiguration : IEntityTypeConfiguration<BrowserSession>
{
    /// <inheritdoc />
    public void Configure(EntityTypeBuilder<BrowserSession> builder)
    {
        ArgumentNullException.ThrowIfNull(builder);

        builder.ToTable(NixTables.BrowserSession);
        builder.HasKey(session => session.Id);
        builder.Property(session => session.Id).HasColumnName("session_id");
        builder.Property(session => session.TenantId).HasColumnName(NixTables.TenantIdColumn);
        builder.Property(session => session.PrincipalId).HasColumnName("principal_id");
        builder.Property(session => session.TokenHash)
            .HasColumnName("token_hash")
            .HasMaxLength(BrowserSession.TokenHashLength)
            .IsRequired();
        builder.Property(session => session.CreatedAt).HasColumnName("created_at");
        builder.Property(session => session.ExpiresAt).HasColumnName("expires_at");
        builder.Property(session => session.RevokedAt).HasColumnName("revoked_at");

        builder.HasOne<Principal>()
            .WithMany()
            .HasForeignKey(session => new { session.TenantId, session.PrincipalId })
            .HasPrincipalKey(principal => new { principal.TenantId, principal.Id })
            .OnDelete(DeleteBehavior.Cascade);

        builder.HasIndex(session => session.TokenHash)
            .IsUnique()
            .HasDatabaseName("IX_browser_session_token_hash");
        builder.HasIndex(session => new { session.TenantId, session.PrincipalId, session.ExpiresAt })
            .HasDatabaseName("IX_browser_session_tenant_principal_expiry");
    }
}
