using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.ChangeTracking;
using Microsoft.EntityFrameworkCore.Metadata.Builders;
using Nix.Domain.Identity;
using Nix.Persistence.Conversion;

namespace Nix.Persistence.Configurations;

/// <summary>
/// Maps <see cref="PersonalAccessToken"/> to <c>personal_access_token</c>.
/// </summary>
internal sealed class PersonalAccessTokenConfiguration : IEntityTypeConfiguration<PersonalAccessToken>
{
    /// <inheritdoc />
    public void Configure(EntityTypeBuilder<PersonalAccessToken> builder)
    {
        ArgumentNullException.ThrowIfNull(builder);

        builder.ToTable(NixTables.PersonalAccessToken);

        builder.HasKey(token => token.Id);
        builder.Property(token => token.Id).HasColumnName("token_id");
        builder.Property(token => token.TenantId).HasColumnName(NixTables.TenantIdColumn);
        builder.Property(token => token.PrincipalId).HasColumnName("principal_id");

        builder.Property(token => token.Name)
            .HasColumnName("name")
            .HasMaxLength(PersonalAccessToken.MaximumNameLength)
            .IsRequired();

        builder.Property(token => token.Lookup)
            .HasColumnName("lookup")
            .HasMaxLength(32)
            .IsRequired();

        builder.Property(token => token.SecretHash)
            .HasColumnName("secret_hash")
            .HasColumnType("bytea")
            .HasConversion(new BinaryPayloadConverter(), BinaryPayloadConverter.Comparer)
            .IsRequired();

        // text[] for the same reason identity_provider.allowed_algorithms is: a ceiling is a set,
        // and "which tokens hold admin" should be a query rather than a scan-and-split. The
        // comparer exists because EF cannot snapshot a read-only list structurally on its own.
        builder.Property(token => token.Scopes)
            .HasColumnName("scopes")
            .HasColumnType("text[]")
            .HasConversion(
                scopes => scopes.ToArray(),
                stored => (IReadOnlyList<string>)stored,
                new ValueComparer<IReadOnlyList<string>>(
                    (left, right) => left != null && right != null && left.SequenceEqual(right),
                    scopes => scopes.Aggregate(
                        0,
                        (hash, scope) => HashCode.Combine(hash, scope.GetHashCode(StringComparison.Ordinal))),
                    scopes => scopes.ToArray()))
            .IsRequired();

        builder.Property(token => token.CreatedAt).HasColumnName("created_at");
        builder.Property(token => token.ExpiresAt).HasColumnName("expires_at");
        builder.Property(token => token.RevokedAt).HasColumnName("revoked_at");
        builder.Property(token => token.LastUsedAt).HasColumnName("last_used_at");

        builder.HasOne<Principal>()
            .WithMany()
            .HasForeignKey(token => new { token.TenantId, token.PrincipalId })
            .HasPrincipalKey(principal => new { principal.TenantId, principal.Id })

            // A token is a credential for the principal, not a reference to them: when they are
            // purged, everything that could act as them goes too.
            .OnDelete(DeleteBehavior.Cascade);

        // Authentication is one read on this index: the presented token's lookup half selects at
        // most one row, before any tenant is known. Unique globally, not per tenant, because the
        // lookup arrives before the tenant does.
        builder.HasIndex(token => token.Lookup)
            .IsUnique()
            .HasDatabaseName("IX_personal_access_token_lookup");

        // The only list read is "this principal's tokens, newest first".
        builder.HasIndex(token => new { token.TenantId, token.PrincipalId, token.CreatedAt })
            .HasDatabaseName("IX_personal_access_token_tenant_id_principal_id_created_at");
    }
}
