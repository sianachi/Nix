using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Nix.Persistence.Migrations.Generated
{
    /// <inheritdoc />
    public partial class PluginEventRuntime : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.CreateTable(
                name: "plugin_event_receipt",
                columns: table => new
                {
                    tenant_id = table.Column<Guid>(type: "uuid", nullable: false),
                    event_id = table.Column<Guid>(type: "uuid", nullable: false),
                    workspace_id = table.Column<Guid>(type: "uuid", nullable: false),
                    kind = table.Column<string>(type: "character varying(64)", maxLength: 64, nullable: false),
                    item_id = table.Column<Guid>(type: "uuid", nullable: true),
                    aggregate_version = table.Column<long>(type: "bigint", nullable: true),
                    causation_id = table.Column<Guid>(type: "uuid", nullable: false),
                    causation_depth = table.Column<int>(type: "integer", nullable: false),
                    received_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_plugin_event_receipt", x => new { x.tenant_id, x.event_id });
                    table.ForeignKey(
                        name: "FK_plugin_event_receipt_workspace_tenant_id_workspace_id",
                        columns: x => new { x.tenant_id, x.workspace_id },
                        principalTable: "workspace",
                        principalColumns: new[] { "tenant_id", "workspace_id" },
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateTable(
                name: "plugin_publisher",
                columns: table => new
                {
                    tenant_id = table.Column<Guid>(type: "uuid", nullable: false),
                    publisher_id = table.Column<string>(type: "character varying(128)", maxLength: 128, nullable: false),
                    ed25519_public_key = table.Column<byte[]>(type: "bytea", nullable: false),
                    pinned_by = table.Column<Guid>(type: "uuid", nullable: false),
                    pinned_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_plugin_publisher", x => new { x.tenant_id, x.publisher_id });
                });

            migrationBuilder.CreateTable(
                name: "plugin_component",
                columns: table => new
                {
                    tenant_id = table.Column<Guid>(type: "uuid", nullable: false),
                    component_id = table.Column<string>(type: "character varying(257)", maxLength: 257, nullable: false),
                    component_version = table.Column<string>(type: "character varying(64)", maxLength: 64, nullable: false),
                    publisher_id = table.Column<string>(type: "character varying(128)", maxLength: 128, nullable: false),
                    object_key = table.Column<string>(type: "character varying(1024)", maxLength: 1024, nullable: false),
                    sha256 = table.Column<string>(type: "character varying(64)", maxLength: 64, nullable: false),
                    byte_length = table.Column<long>(type: "bigint", nullable: false),
                    ed25519_signature = table.Column<byte[]>(type: "bytea", nullable: false),
                    registered_by = table.Column<Guid>(type: "uuid", nullable: false),
                    registered_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_plugin_component", x => new { x.tenant_id, x.component_id, x.component_version });
                    table.ForeignKey(
                        name: "FK_plugin_component_plugin_publisher_tenant_id_publisher_id",
                        columns: x => new { x.tenant_id, x.publisher_id },
                        principalTable: "plugin_publisher",
                        principalColumns: new[] { "tenant_id", "publisher_id" },
                        onDelete: ReferentialAction.Restrict);
                });

            migrationBuilder.CreateTable(
                name: "plugin_installation",
                columns: table => new
                {
                    installation_id = table.Column<Guid>(type: "uuid", nullable: false),
                    tenant_id = table.Column<Guid>(type: "uuid", nullable: false),
                    workspace_id = table.Column<Guid>(type: "uuid", nullable: false),
                    component_id = table.Column<string>(type: "character varying(257)", maxLength: 257, nullable: false),
                    component_version = table.Column<string>(type: "character varying(64)", maxLength: 64, nullable: false),
                    enabled = table.Column<bool>(type: "boolean", nullable: false),
                    installed_by = table.Column<Guid>(type: "uuid", nullable: false),
                    installed_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    updated_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_plugin_installation", x => x.installation_id);
                    table.UniqueConstraint("AK_plugin_installation_tenant_id_installation_id", x => new { x.tenant_id, x.installation_id });
                    table.ForeignKey(
                        name: "FK_plugin_installation_plugin_component_tenant_id_component_id~",
                        columns: x => new { x.tenant_id, x.component_id, x.component_version },
                        principalTable: "plugin_component",
                        principalColumns: new[] { "tenant_id", "component_id", "component_version" },
                        onDelete: ReferentialAction.Restrict);
                    table.ForeignKey(
                        name: "FK_plugin_installation_workspace_tenant_id_workspace_id",
                        columns: x => new { x.tenant_id, x.workspace_id },
                        principalTable: "workspace",
                        principalColumns: new[] { "tenant_id", "workspace_id" },
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateTable(
                name: "plugin_capability_grant",
                columns: table => new
                {
                    tenant_id = table.Column<Guid>(type: "uuid", nullable: false),
                    installation_id = table.Column<Guid>(type: "uuid", nullable: false),
                    capability = table.Column<string>(type: "character varying(64)", maxLength: 64, nullable: false),
                    granted_by = table.Column<Guid>(type: "uuid", nullable: false),
                    granted_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_plugin_capability_grant", x => new { x.tenant_id, x.installation_id, x.capability });
                    table.ForeignKey(
                        name: "FK_plugin_capability_grant_plugin_installation_tenant_id_insta~",
                        columns: x => new { x.tenant_id, x.installation_id },
                        principalTable: "plugin_installation",
                        principalColumns: new[] { "tenant_id", "installation_id" },
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateTable(
                name: "plugin_event_inbox",
                columns: table => new
                {
                    tenant_id = table.Column<Guid>(type: "uuid", nullable: false),
                    event_id = table.Column<Guid>(type: "uuid", nullable: false),
                    installation_id = table.Column<Guid>(type: "uuid", nullable: false),
                    workspace_id = table.Column<Guid>(type: "uuid", nullable: false),
                    kind = table.Column<string>(type: "character varying(64)", maxLength: 64, nullable: false),
                    item_id = table.Column<Guid>(type: "uuid", nullable: true),
                    aggregate_version = table.Column<long>(type: "bigint", nullable: true),
                    causation_id = table.Column<Guid>(type: "uuid", nullable: false),
                    causation_depth = table.Column<int>(type: "integer", nullable: false),
                    status = table.Column<string>(type: "character varying(16)", maxLength: 16, nullable: false),
                    attempts = table.Column<int>(type: "integer", nullable: false),
                    current_invocation_id = table.Column<Guid>(type: "uuid", nullable: true),
                    error_code = table.Column<string>(type: "character varying(64)", maxLength: 64, nullable: true),
                    error_detail = table.Column<string>(type: "character varying(2000)", maxLength: 2000, nullable: true),
                    created_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    updated_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    completed_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_plugin_event_inbox", x => new { x.tenant_id, x.event_id, x.installation_id });
                    table.ForeignKey(
                        name: "FK_plugin_event_inbox_plugin_event_receipt_tenant_id_event_id",
                        columns: x => new { x.tenant_id, x.event_id },
                        principalTable: "plugin_event_receipt",
                        principalColumns: new[] { "tenant_id", "event_id" },
                        onDelete: ReferentialAction.Cascade);
                    table.ForeignKey(
                        name: "FK_plugin_event_inbox_plugin_installation_tenant_id_installati~",
                        columns: x => new { x.tenant_id, x.installation_id },
                        principalTable: "plugin_installation",
                        principalColumns: new[] { "tenant_id", "installation_id" },
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateTable(
                name: "plugin_invocation",
                columns: table => new
                {
                    invocation_id = table.Column<Guid>(type: "uuid", nullable: false),
                    tenant_id = table.Column<Guid>(type: "uuid", nullable: false),
                    event_id = table.Column<Guid>(type: "uuid", nullable: false),
                    installation_id = table.Column<Guid>(type: "uuid", nullable: false),
                    workspace_id = table.Column<Guid>(type: "uuid", nullable: false),
                    attempt = table.Column<int>(type: "integer", nullable: false),
                    causation_id = table.Column<Guid>(type: "uuid", nullable: false),
                    causation_depth = table.Column<int>(type: "integer", nullable: false),
                    status = table.Column<string>(type: "character varying(16)", maxLength: 16, nullable: false),
                    lease_until = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    completion_fingerprint = table.Column<byte[]>(type: "bytea", nullable: true),
                    succeeded = table.Column<bool>(type: "boolean", nullable: true),
                    retryable = table.Column<bool>(type: "boolean", nullable: true),
                    error_code = table.Column<string>(type: "character varying(64)", maxLength: 64, nullable: true),
                    error_detail = table.Column<string>(type: "character varying(2000)", maxLength: 2000, nullable: true),
                    created_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    completed_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_plugin_invocation", x => x.invocation_id);
                    table.UniqueConstraint("AK_plugin_invocation_tenant_id_invocation_id", x => new { x.tenant_id, x.invocation_id });
                    table.ForeignKey(
                        name: "FK_plugin_invocation_plugin_event_inbox_tenant_id_event_id_ins~",
                        columns: x => new { x.tenant_id, x.event_id, x.installation_id },
                        principalTable: "plugin_event_inbox",
                        principalColumns: new[] { "tenant_id", "event_id", "installation_id" },
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateIndex(
                name: "IX_plugin_component_tenant_id_publisher_id",
                table: "plugin_component",
                columns: new[] { "tenant_id", "publisher_id" });

            migrationBuilder.CreateIndex(
                name: "IX_plugin_event_inbox_status_updated_at",
                table: "plugin_event_inbox",
                columns: new[] { "status", "updated_at" });

            migrationBuilder.CreateIndex(
                name: "IX_plugin_event_inbox_tenant_id_installation_id",
                table: "plugin_event_inbox",
                columns: new[] { "tenant_id", "installation_id" });

            migrationBuilder.CreateIndex(
                name: "IX_plugin_event_receipt_tenant_id_workspace_id",
                table: "plugin_event_receipt",
                columns: new[] { "tenant_id", "workspace_id" });

            migrationBuilder.CreateIndex(
                name: "IX_plugin_installation_tenant_id_component_id_component_version",
                table: "plugin_installation",
                columns: new[] { "tenant_id", "component_id", "component_version" });

            migrationBuilder.CreateIndex(
                name: "IX_plugin_installation_tenant_id_workspace_id_component_id",
                table: "plugin_installation",
                columns: new[] { "tenant_id", "workspace_id", "component_id" },
                unique: true);

            migrationBuilder.CreateIndex(
                name: "IX_plugin_invocation_status_lease_until",
                table: "plugin_invocation",
                columns: new[] { "status", "lease_until" });

            migrationBuilder.CreateIndex(
                name: "IX_plugin_invocation_tenant_id_event_id_installation_id_attempt",
                table: "plugin_invocation",
                columns: new[] { "tenant_id", "event_id", "installation_id", "attempt" },
                unique: true);

            PluginEventRuntimeSecuritySql.Apply(sql => migrationBuilder.Sql(sql));
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            PluginEventRuntimeSecuritySql.Revert(sql => migrationBuilder.Sql(sql));

            migrationBuilder.DropTable(
                name: "plugin_capability_grant");

            migrationBuilder.DropTable(
                name: "plugin_invocation");

            migrationBuilder.DropTable(
                name: "plugin_event_inbox");

            migrationBuilder.DropTable(
                name: "plugin_event_receipt");

            migrationBuilder.DropTable(
                name: "plugin_installation");

            migrationBuilder.DropTable(
                name: "plugin_component");

            migrationBuilder.DropTable(
                name: "plugin_publisher");
        }
    }
}
