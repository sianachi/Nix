using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata.Builders;
using Nix.Domain.Calendar;
using Nix.Domain.Identity;
using Nix.Domain.Items;
using Nix.Domain.Tenancy;

namespace Nix.Persistence.Configurations;

/// <summary>Maps <see cref="CalendarConnection"/> to <c>calendar_connection</c>.</summary>
/// <remarks>Every constraint and index is named explicitly (ADR-0052 Amendment 1).</remarks>
internal sealed class CalendarConnectionConfiguration : IEntityTypeConfiguration<CalendarConnection>
{
    public void Configure(EntityTypeBuilder<CalendarConnection> builder)
    {
        ArgumentNullException.ThrowIfNull(builder);
        builder.ToTable(NixTables.CalendarConnection, table => table.HasCheckConstraint(
            "ck_calendar_connection_bounded",
            "provider IN ('google', 'microsoft')"
                + " AND status IN ('active', 'needs_reauth', 'revoked')"
                + " AND char_length(account_subject) BETWEEN 1 AND 255"
                + " AND char_length(account_email) <= 320"
                + " AND char_length(scopes) <= 1000"
                + " AND (last_error IS NULL OR char_length(last_error) <= 500)"));
        builder.HasKey(row => new { row.TenantId, row.Id }).HasName("pk_calendar_connection");
        builder.Property(row => row.TenantId).HasColumnName(NixTables.TenantIdColumn);
        builder.Property(row => row.Id).HasColumnName("id");
        builder.Property(row => row.PrincipalId).HasColumnName("principal_id");
        builder.Property(row => row.Provider).HasColumnName("provider").HasMaxLength(16).IsRequired();
        builder.Property(row => row.AccountSubject).HasColumnName("account_subject").HasMaxLength(255).IsRequired();
        builder.Property(row => row.AccountEmail).HasColumnName("account_email").HasMaxLength(320).IsRequired();
        builder.Property(row => row.Status).HasColumnName("status").HasMaxLength(16).IsRequired();
        builder.Property(row => row.RefreshTokenProtected).HasColumnName("refresh_token_protected");
        builder.Property(row => row.AccessTokenProtected).HasColumnName("access_token_protected");
        builder.Property(row => row.AccessTokenExpiresAt).HasColumnName("access_token_expires_at");
        builder.Property(row => row.Scopes).HasColumnName("scopes").HasMaxLength(1000).IsRequired();
        builder.Property(row => row.LastError).HasColumnName("last_error").HasMaxLength(500);
        builder.Property(row => row.CreatedAt).HasColumnName("created_at");
        builder.Property(row => row.UpdatedAt).HasColumnName("updated_at");

        // A connection is its owner's private grant: it goes when they are purged.
        builder.HasOne<Principal>().WithMany()
            .HasForeignKey(row => new { row.TenantId, row.PrincipalId })
            .HasPrincipalKey(principal => new { principal.TenantId, principal.Id })
            .HasConstraintName("fk_calendar_connection_principal")
            .OnDelete(DeleteBehavior.Cascade);

        // Reconnecting the same provider account updates this row rather than adding another.
        builder.HasIndex(row => new { row.TenantId, row.PrincipalId, row.Provider, row.AccountSubject })
            .IsUnique()
            .HasDatabaseName("ux_calendar_connection_account");
    }
}

/// <summary>Maps <see cref="CalendarLink"/> to <c>calendar_link</c>.</summary>
internal sealed class CalendarLinkConfiguration : IEntityTypeConfiguration<CalendarLink>
{
    public void Configure(EntityTypeBuilder<CalendarLink> builder)
    {
        ArgumentNullException.ThrowIfNull(builder);
        builder.ToTable(NixTables.CalendarLink, table => table.HasCheckConstraint(
            "ck_calendar_link_bounded",
            "direction IN ('two_way', 'import_only')"
                + " AND status IN ('active', 'paused', 'stopped', 'error')"
                + " AND window_past_days BETWEEN 0 AND 365"
                + " AND window_future_days BETWEEN 1 AND 730"
                + " AND char_length(external_calendar_id) BETWEEN 1 AND 500"
                + " AND char_length(name) BETWEEN 1 AND 200"
                + " AND (sync_cursor IS NULL OR char_length(sync_cursor) <= 4096)"
                + " AND (last_error IS NULL OR char_length(last_error) <= 500)"
                + " AND revision >= 1"));
        builder.HasKey(row => new { row.TenantId, row.Id }).HasName("pk_calendar_link");
        builder.Property(row => row.TenantId).HasColumnName(NixTables.TenantIdColumn);
        builder.Property(row => row.Id).HasColumnName("id");
        builder.Property(row => row.PrincipalId).HasColumnName("principal_id");
        builder.Property(row => row.ConnectionId).HasColumnName("connection_id");
        builder.Property(row => row.WorkspaceId).HasColumnName("workspace_id");
        builder.Property(row => row.ContainerItemId).HasColumnName("container_item_id");
        builder.Property(row => row.ExternalCalendarId).HasColumnName("external_calendar_id").HasMaxLength(500).IsRequired();
        builder.Property(row => row.Name).HasColumnName("name").HasMaxLength(200).IsRequired();
        builder.Property(row => row.Direction).HasColumnName("direction").HasMaxLength(16).IsRequired();
        builder.Property(row => row.WindowPastDays).HasColumnName("window_past_days").HasDefaultValue((short)30);
        builder.Property(row => row.WindowFutureDays).HasColumnName("window_future_days").HasDefaultValue((short)365);
        builder.Property(row => row.SyncCursor).HasColumnName("sync_cursor").HasMaxLength(4096);
        builder.Property(row => row.CursorWindowStart).HasColumnName("cursor_window_start");
        builder.Property(row => row.CursorWindowEnd).HasColumnName("cursor_window_end");
        builder.Property(row => row.Status).HasColumnName("status").HasMaxLength(16).IsRequired();
        builder.Property(row => row.LastSyncedAt).HasColumnName("last_synced_at");
        builder.Property(row => row.LastError).HasColumnName("last_error").HasMaxLength(500);
        builder.Property(row => row.LastJobId).HasColumnName("last_job_id");
        builder.Property(row => row.Revision).HasColumnName("revision").HasDefaultValue(1);
        builder.Property(row => row.CreatedAt).HasColumnName("created_at");
        builder.Property(row => row.UpdatedAt).HasColumnName("updated_at");

        builder.HasOne<CalendarConnection>().WithMany()
            .HasForeignKey(row => new { row.TenantId, row.ConnectionId })
            .HasPrincipalKey(connection => new { connection.TenantId, connection.Id })
            .HasConstraintName("fk_calendar_link_connection")
            .OnDelete(DeleteBehavior.Cascade);
        builder.HasOne<Workspace>().WithMany()
            .HasForeignKey(row => new { row.TenantId, row.WorkspaceId })
            .HasPrincipalKey(workspace => new { workspace.TenantId, workspace.Id })
            .HasConstraintName("fk_calendar_link_workspace")
            .OnDelete(DeleteBehavior.Cascade);
        builder.HasOne<Item>().WithMany()
            .HasForeignKey(row => new { row.TenantId, row.ContainerItemId })
            .HasPrincipalKey(item => new { item.TenantId, item.Id })
            .HasConstraintName("fk_calendar_link_container_item")
            .OnDelete(DeleteBehavior.Cascade);

        // One link per container, and the dirty trigger's single probe per written item.
        builder.HasIndex(row => new { row.TenantId, row.ContainerItemId })
            .IsUnique()
            .HasDatabaseName("ux_calendar_link_container");

        // One link per external calendar of a connection; also the connection foreign key's index.
        builder.HasIndex(row => new { row.TenantId, row.ConnectionId, row.ExternalCalendarId })
            .IsUnique()
            .HasDatabaseName("ux_calendar_link_calendar");

        // The workspace foreign key's index, and the owner's per-workspace listing.
        builder.HasIndex(row => new { row.TenantId, row.WorkspaceId })
            .HasDatabaseName("ix_calendar_link_workspace");

        // The planner's cross-tenant keyset over active links.
        builder.HasIndex(row => row.Id)
            .HasFilter("status = 'active'")
            .HasDatabaseName("ix_calendar_link_active");
    }
}

/// <summary>Maps <see cref="CalendarEventMap"/> to <c>calendar_event_map</c>.</summary>
internal sealed class CalendarEventMapConfiguration : IEntityTypeConfiguration<CalendarEventMap>
{
    public void Configure(EntityTypeBuilder<CalendarEventMap> builder)
    {
        ArgumentNullException.ThrowIfNull(builder);
        builder.ToTable(NixTables.CalendarEventMap, table => table.HasCheckConstraint(
            "ck_calendar_event_map_bounded",
            "(external_event_id IS NULL OR char_length(external_event_id) BETWEEN 1 AND 500)"
                + " AND (external_version IS NULL OR char_length(external_version) <= 4096)"
                + " AND (seen_execution IS NULL OR char_length(seen_execution) <= 128)"
                + " AND (last_synced_hash IS NULL OR octet_length(last_synced_hash) = 32)"
                + " AND (push_hash IS NULL OR octet_length(push_hash) = 32)"
                + " AND (push_op IS NULL OR push_op IN ('create', 'update', 'delete'))"
                + " AND push_failures >= 0"));
        builder.HasKey(row => new { row.TenantId, row.Id }).HasName("pk_calendar_event_map");
        builder.Property(row => row.TenantId).HasColumnName(NixTables.TenantIdColumn);
        builder.Property(row => row.Id).HasColumnName("id");
        builder.Property(row => row.LinkId).HasColumnName("link_id");
        builder.Property(row => row.PrincipalId).HasColumnName("principal_id");
        builder.Property(row => row.ItemId).HasColumnName("item_id");
        builder.Property(row => row.ExternalEventId).HasColumnName("external_event_id").HasMaxLength(500);
        builder.Property(row => row.ExternalVersion).HasColumnName("external_version").HasMaxLength(4096);
        builder.Property(row => row.ExternalUpdatedAt).HasColumnName("external_updated_at");
        builder.Property(row => row.NixVersion).HasColumnName("nix_version");
        builder.Property(row => row.LastSyncedHash).HasColumnName("last_synced_hash");
        builder.Property(row => row.PushNixVersion).HasColumnName("push_nix_version");
        builder.Property(row => row.PushHash).HasColumnName("push_hash");
        builder.Property(row => row.PushOp).HasColumnName("push_op").HasMaxLength(8);
        builder.Property(row => row.PushFailures).HasColumnName("push_failures").HasDefaultValue((short)0);
        builder.Property(row => row.SeenExecution).HasColumnName("seen_execution").HasMaxLength(128);
        builder.Property(row => row.DeletedAt).HasColumnName("deleted_at");
        builder.Property(row => row.CreatedAt).HasColumnName("created_at");
        builder.Property(row => row.UpdatedAt).HasColumnName("updated_at");

        builder.HasOne<CalendarLink>().WithMany()
            .HasForeignKey(row => new { row.TenantId, row.LinkId })
            .HasPrincipalKey(link => new { link.TenantId, link.Id })
            .HasConstraintName("fk_calendar_event_map_link")
            .OnDelete(DeleteBehavior.Cascade);

        builder.HasIndex(row => new { row.TenantId, row.LinkId, row.ExternalEventId })
            .IsUnique()
            .HasFilter("external_event_id IS NOT NULL")
            .HasDatabaseName("ux_calendar_event_map_external");

        // One row per mirrored item; also the link foreign key's index.
        builder.HasIndex(row => new { row.TenantId, row.LinkId, row.ItemId })
            .IsUnique()
            .HasDatabaseName("ux_calendar_event_map_item");

        // nix_purge_calendar_sync_log's tombstone sweep, across every tenant by age alone.
        builder.HasIndex(row => row.DeletedAt)
            .HasFilter("deleted_at IS NOT NULL")
            .HasDatabaseName("ix_calendar_event_map_deleted_at");
    }
}

/// <summary>Maps <see cref="CalendarSyncLogEntry"/> to <c>calendar_sync_log</c>.</summary>
internal sealed class CalendarSyncLogConfiguration : IEntityTypeConfiguration<CalendarSyncLogEntry>
{
    public void Configure(EntityTypeBuilder<CalendarSyncLogEntry> builder)
    {
        ArgumentNullException.ThrowIfNull(builder);
        builder.ToTable(NixTables.CalendarSyncLog, table => table.HasCheckConstraint(
            "ck_calendar_sync_log_bounded",
            "direction IN ('pull', 'push')"
                + " AND action IN ('created', 'updated', 'deleted', 'conflict', 'skipped', 'error')"
                + " AND char_length(detail) <= 500"
                + " AND (external_event_id IS NULL OR char_length(external_event_id) <= 500)"));
        builder.HasKey(row => new { row.TenantId, row.Id }).HasName("pk_calendar_sync_log");
        builder.Property(row => row.TenantId).HasColumnName(NixTables.TenantIdColumn);
        builder.Property(row => row.Id).HasColumnName("id");
        builder.Property(row => row.LinkId).HasColumnName("link_id");
        builder.Property(row => row.PrincipalId).HasColumnName("principal_id");
        builder.Property(row => row.At).HasColumnName("at");
        builder.Property(row => row.Direction).HasColumnName("direction").HasMaxLength(8).IsRequired();
        builder.Property(row => row.Action).HasColumnName("action").HasMaxLength(16).IsRequired();
        builder.Property(row => row.ItemId).HasColumnName("item_id");
        builder.Property(row => row.ExternalEventId).HasColumnName("external_event_id").HasMaxLength(500);
        builder.Property(row => row.Detail).HasColumnName("detail").HasMaxLength(500).IsRequired();

        builder.HasOne<CalendarLink>().WithMany()
            .HasForeignKey(row => new { row.TenantId, row.LinkId })
            .HasPrincipalKey(link => new { link.TenantId, link.Id })
            .HasConstraintName("fk_calendar_sync_log_link")
            .OnDelete(DeleteBehavior.Cascade);

        // The visible log page (newest first) and the link foreign key's index.
        builder.HasIndex(row => new { row.TenantId, row.LinkId, row.At, row.Id })
            .IsDescending(false, false, true, true)
            .HasDatabaseName("ix_calendar_sync_log_link_at");

        // nix_purge_calendar_sync_log, across every tenant by age alone.
        builder.HasIndex(row => row.At).HasDatabaseName("ix_calendar_sync_log_at");
    }
}
