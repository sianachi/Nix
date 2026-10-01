using System;
using Microsoft.EntityFrameworkCore.Migrations;
using Nix.Persistence.Migrations;

#nullable disable

namespace Nix.Persistence.Migrations.Generated
{
    /// <inheritdoc />
    public partial class AddCalendarSync : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropCheckConstraint(
                name: "scheduled_trigger_bounded",
                table: "scheduled_trigger");

            migrationBuilder.CreateTable(
                name: "calendar_connection",
                columns: table => new
                {
                    tenant_id = table.Column<Guid>(type: "uuid", nullable: false),
                    id = table.Column<Guid>(type: "uuid", nullable: false),
                    principal_id = table.Column<Guid>(type: "uuid", nullable: false),
                    provider = table.Column<string>(type: "character varying(16)", maxLength: 16, nullable: false),
                    account_subject = table.Column<string>(type: "character varying(255)", maxLength: 255, nullable: false),
                    account_email = table.Column<string>(type: "character varying(320)", maxLength: 320, nullable: false),
                    status = table.Column<string>(type: "character varying(16)", maxLength: 16, nullable: false),
                    refresh_token_protected = table.Column<byte[]>(type: "bytea", nullable: true),
                    access_token_protected = table.Column<byte[]>(type: "bytea", nullable: true),
                    access_token_expires_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true),
                    scopes = table.Column<string>(type: "character varying(1000)", maxLength: 1000, nullable: false),
                    last_error = table.Column<string>(type: "character varying(500)", maxLength: 500, nullable: true),
                    created_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    updated_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_calendar_connection", x => new { x.tenant_id, x.id });
                    table.CheckConstraint("ck_calendar_connection_bounded", "provider IN ('google', 'microsoft') AND status IN ('active', 'needs_reauth', 'revoked') AND char_length(account_subject) BETWEEN 1 AND 255 AND char_length(account_email) <= 320 AND char_length(scopes) <= 1000 AND (last_error IS NULL OR char_length(last_error) <= 500)");
                    table.ForeignKey(
                        name: "fk_calendar_connection_principal",
                        columns: x => new { x.tenant_id, x.principal_id },
                        principalTable: "principal",
                        principalColumns: new[] { "tenant_id", "principal_id" },
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateTable(
                name: "calendar_link",
                columns: table => new
                {
                    tenant_id = table.Column<Guid>(type: "uuid", nullable: false),
                    id = table.Column<Guid>(type: "uuid", nullable: false),
                    principal_id = table.Column<Guid>(type: "uuid", nullable: false),
                    connection_id = table.Column<Guid>(type: "uuid", nullable: false),
                    workspace_id = table.Column<Guid>(type: "uuid", nullable: false),
                    container_item_id = table.Column<Guid>(type: "uuid", nullable: false),
                    external_calendar_id = table.Column<string>(type: "character varying(500)", maxLength: 500, nullable: false),
                    name = table.Column<string>(type: "character varying(200)", maxLength: 200, nullable: false),
                    direction = table.Column<string>(type: "character varying(16)", maxLength: 16, nullable: false),
                    window_past_days = table.Column<short>(type: "smallint", nullable: false, defaultValue: (short)30),
                    window_future_days = table.Column<short>(type: "smallint", nullable: false, defaultValue: (short)365),
                    sync_cursor = table.Column<string>(type: "character varying(4096)", maxLength: 4096, nullable: true),
                    cursor_window_start = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true),
                    cursor_window_end = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true),
                    status = table.Column<string>(type: "character varying(16)", maxLength: 16, nullable: false),
                    last_synced_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true),
                    last_error = table.Column<string>(type: "character varying(500)", maxLength: 500, nullable: true),
                    last_job_id = table.Column<Guid>(type: "uuid", nullable: true),
                    revision = table.Column<int>(type: "integer", nullable: false, defaultValue: 1),
                    created_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    updated_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_calendar_link", x => new { x.tenant_id, x.id });
                    table.CheckConstraint("ck_calendar_link_bounded", "direction IN ('two_way', 'import_only') AND status IN ('active', 'paused', 'stopped', 'error') AND window_past_days BETWEEN 0 AND 365 AND window_future_days BETWEEN 1 AND 730 AND char_length(external_calendar_id) BETWEEN 1 AND 500 AND char_length(name) BETWEEN 1 AND 200 AND (sync_cursor IS NULL OR char_length(sync_cursor) <= 4096) AND (last_error IS NULL OR char_length(last_error) <= 500) AND revision >= 1");
                    table.ForeignKey(
                        name: "fk_calendar_link_connection",
                        columns: x => new { x.tenant_id, x.connection_id },
                        principalTable: "calendar_connection",
                        principalColumns: new[] { "tenant_id", "id" },
                        onDelete: ReferentialAction.Cascade);
                    table.ForeignKey(
                        name: "fk_calendar_link_container_item",
                        columns: x => new { x.tenant_id, x.container_item_id },
                        principalTable: "item",
                        principalColumns: new[] { "tenant_id", "id" },
                        onDelete: ReferentialAction.Cascade);
                    table.ForeignKey(
                        name: "fk_calendar_link_workspace",
                        columns: x => new { x.tenant_id, x.workspace_id },
                        principalTable: "workspace",
                        principalColumns: new[] { "tenant_id", "workspace_id" },
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateTable(
                name: "calendar_event_map",
                columns: table => new
                {
                    tenant_id = table.Column<Guid>(type: "uuid", nullable: false),
                    id = table.Column<Guid>(type: "uuid", nullable: false),
                    link_id = table.Column<Guid>(type: "uuid", nullable: false),
                    principal_id = table.Column<Guid>(type: "uuid", nullable: false),
                    item_id = table.Column<Guid>(type: "uuid", nullable: false),
                    external_event_id = table.Column<string>(type: "character varying(500)", maxLength: 500, nullable: true),
                    external_version = table.Column<string>(type: "character varying(4096)", maxLength: 4096, nullable: true),
                    external_updated_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true),
                    nix_version = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true),
                    last_synced_hash = table.Column<byte[]>(type: "bytea", nullable: true),
                    push_nix_version = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true),
                    push_hash = table.Column<byte[]>(type: "bytea", nullable: true),
                    push_op = table.Column<string>(type: "character varying(8)", maxLength: 8, nullable: true),
                    push_failures = table.Column<short>(type: "smallint", nullable: false, defaultValue: (short)0),
                    seen_execution = table.Column<string>(type: "character varying(128)", maxLength: 128, nullable: true),
                    deleted_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true),
                    created_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    updated_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_calendar_event_map", x => new { x.tenant_id, x.id });
                    table.CheckConstraint("ck_calendar_event_map_bounded", "(external_event_id IS NULL OR char_length(external_event_id) BETWEEN 1 AND 500) AND (external_version IS NULL OR char_length(external_version) <= 4096) AND (seen_execution IS NULL OR char_length(seen_execution) <= 128) AND (last_synced_hash IS NULL OR octet_length(last_synced_hash) = 32) AND (push_hash IS NULL OR octet_length(push_hash) = 32) AND (push_op IS NULL OR push_op IN ('create', 'update', 'delete')) AND push_failures >= 0");
                    table.ForeignKey(
                        name: "fk_calendar_event_map_link",
                        columns: x => new { x.tenant_id, x.link_id },
                        principalTable: "calendar_link",
                        principalColumns: new[] { "tenant_id", "id" },
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateTable(
                name: "calendar_sync_log",
                columns: table => new
                {
                    tenant_id = table.Column<Guid>(type: "uuid", nullable: false),
                    id = table.Column<Guid>(type: "uuid", nullable: false),
                    link_id = table.Column<Guid>(type: "uuid", nullable: false),
                    principal_id = table.Column<Guid>(type: "uuid", nullable: false),
                    at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    direction = table.Column<string>(type: "character varying(8)", maxLength: 8, nullable: false),
                    action = table.Column<string>(type: "character varying(16)", maxLength: 16, nullable: false),
                    item_id = table.Column<Guid>(type: "uuid", nullable: true),
                    external_event_id = table.Column<string>(type: "character varying(500)", maxLength: 500, nullable: true),
                    detail = table.Column<string>(type: "character varying(500)", maxLength: 500, nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_calendar_sync_log", x => new { x.tenant_id, x.id });
                    table.CheckConstraint("ck_calendar_sync_log_bounded", "direction IN ('pull', 'push') AND action IN ('created', 'updated', 'deleted', 'conflict', 'skipped', 'error') AND char_length(detail) <= 500 AND (external_event_id IS NULL OR char_length(external_event_id) <= 500)");
                    table.ForeignKey(
                        name: "fk_calendar_sync_log_link",
                        columns: x => new { x.tenant_id, x.link_id },
                        principalTable: "calendar_link",
                        principalColumns: new[] { "tenant_id", "id" },
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.AddCheckConstraint(
                name: "scheduled_trigger_bounded",
                table: "scheduled_trigger",
                sql: "kind IN ('reminder', 'automation', 'system', 'calendar') AND status IN ('pending', 'leased', 'fired', 'skipped', 'cancelled') AND attempts >= 0 AND char_length(dedupe_key) <= 200 AND (lease_owner IS NULL OR char_length(lease_owner) <= 128) AND char_length(source) <= 64 AND source ~ '^[a-z0-9._-]+$'");

            migrationBuilder.CreateIndex(
                name: "ux_calendar_connection_account",
                table: "calendar_connection",
                columns: new[] { "tenant_id", "principal_id", "provider", "account_subject" },
                unique: true);

            migrationBuilder.CreateIndex(
                name: "ix_calendar_event_map_deleted_at",
                table: "calendar_event_map",
                column: "deleted_at",
                filter: "deleted_at IS NOT NULL");

            migrationBuilder.CreateIndex(
                name: "ux_calendar_event_map_external",
                table: "calendar_event_map",
                columns: new[] { "tenant_id", "link_id", "external_event_id" },
                unique: true,
                filter: "external_event_id IS NOT NULL");

            migrationBuilder.CreateIndex(
                name: "ux_calendar_event_map_item",
                table: "calendar_event_map",
                columns: new[] { "tenant_id", "link_id", "item_id" },
                unique: true);

            migrationBuilder.CreateIndex(
                name: "ix_calendar_link_active",
                table: "calendar_link",
                column: "id",
                filter: "status = 'active'");

            migrationBuilder.CreateIndex(
                name: "ix_calendar_link_workspace",
                table: "calendar_link",
                columns: new[] { "tenant_id", "workspace_id" });

            migrationBuilder.CreateIndex(
                name: "ux_calendar_link_calendar",
                table: "calendar_link",
                columns: new[] { "tenant_id", "connection_id", "external_calendar_id" },
                unique: true);

            migrationBuilder.CreateIndex(
                name: "ux_calendar_link_container",
                table: "calendar_link",
                columns: new[] { "tenant_id", "container_item_id" },
                unique: true);

            migrationBuilder.CreateIndex(
                name: "ix_calendar_sync_log_at",
                table: "calendar_sync_log",
                column: "at");

            migrationBuilder.CreateIndex(
                name: "ix_calendar_sync_log_link_at",
                table: "calendar_sync_log",
                columns: new[] { "tenant_id", "link_id", "at", "id" },
                descending: new[] { false, false, true, true });

            CalendarSyncSecuritySql.Apply(sql => migrationBuilder.Sql(sql));
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            CalendarSyncSecuritySql.Revert(sql => migrationBuilder.Sql(sql));

            migrationBuilder.DropTable(
                name: "calendar_event_map");

            migrationBuilder.DropTable(
                name: "calendar_sync_log");

            migrationBuilder.DropTable(
                name: "calendar_link");

            migrationBuilder.DropTable(
                name: "calendar_connection");

            migrationBuilder.DropCheckConstraint(
                name: "scheduled_trigger_bounded",
                table: "scheduled_trigger");

            migrationBuilder.AddCheckConstraint(
                name: "scheduled_trigger_bounded",
                table: "scheduled_trigger",
                sql: "kind IN ('reminder', 'automation', 'system') AND status IN ('pending', 'leased', 'fired', 'skipped', 'cancelled') AND attempts >= 0 AND char_length(dedupe_key) <= 200 AND (lease_owner IS NULL OR char_length(lease_owner) <= 128) AND char_length(source) <= 64 AND source ~ '^[a-z0-9._-]+$'");
        }
    }
}
