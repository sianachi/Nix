using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata.Builders;
using Nix.Core.Identity;

namespace Nix.Infrastructure.Persistence.Configurations;

/// <summary>
/// Maps <see cref="GroupMembership"/> to <c>group_membership</c>.
/// </summary>
/// <remarks>
/// Both references are composite on <c>tenant_id</c>. A membership that joined one tenant's
/// principal to another tenant's group would be a cross-tenant edge in the permission graph, and
/// the schema should make that unrepresentable rather than rely on the code that writes it.
/// </remarks>
internal sealed class GroupMembershipConfiguration : IEntityTypeConfiguration<GroupMembership>
{
    /// <inheritdoc />
    public void Configure(EntityTypeBuilder<GroupMembership> builder)
    {
        ArgumentNullException.ThrowIfNull(builder);

        builder.ToTable(NixTables.GroupMembership);

        builder.HasKey(membership => new { membership.GroupId, membership.PrincipalId });

        builder.Property(membership => membership.GroupId).HasColumnName("group_id");
        builder.Property(membership => membership.PrincipalId).HasColumnName("principal_id");
        builder.Property(membership => membership.TenantId).HasColumnName(NixTables.TenantIdColumn);
        builder.Property(membership => membership.Source).HasColumnName("source").IsRequired();

        builder.HasOne<PrincipalGroup>()
            .WithMany()
            .HasForeignKey(membership => new { membership.TenantId, membership.GroupId })
            .HasPrincipalKey(group => new { group.TenantId, group.Id })
            .OnDelete(DeleteBehavior.Cascade);

        builder.HasOne<Principal>()
            .WithMany()
            .HasForeignKey(membership => new { membership.TenantId, membership.PrincipalId })
            .HasPrincipalKey(principal => new { principal.TenantId, principal.Id })
            .OnDelete(DeleteBehavior.Cascade);

        // "Which groups is this principal in" is the direction permission resolution asks in, and
        // the primary key leads with group_id, so it cannot serve that lookup.
        builder.HasIndex(membership => new { membership.TenantId, membership.PrincipalId });
    }
}
