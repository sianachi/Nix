using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Nix.Persistence.Migrations.Generated
{
    /// <inheritdoc />
    public partial class WorkspaceTemplates : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<bool>(
                name: "can_manage_templates",
                table: "principal",
                type: "boolean",
                nullable: false,
                defaultValue: false);

            migrationBuilder.AddColumn<Guid>(
                name: "template_id",
                table: "item",
                type: "uuid",
                nullable: true);

            migrationBuilder.AddColumn<Guid>(
                name: "template_source_id",
                table: "item",
                type: "uuid",
                nullable: true);

            migrationBuilder.CreateTable(
                name: "workspace_template",
                columns: table => new
                {
                    template_id = table.Column<Guid>(type: "uuid", nullable: false),
                    tenant_id = table.Column<Guid>(type: "uuid", nullable: false),
                    workspace_id = table.Column<Guid>(type: "uuid", nullable: false),
                    root_item_id = table.Column<Guid>(type: "uuid", nullable: true),
                    pending_root_item_id = table.Column<Guid>(type: "uuid", nullable: true),
                    stable_key = table.Column<string>(type: "character varying(160)", maxLength: 160, nullable: false),
                    profile_key = table.Column<string>(type: "character varying(160)", maxLength: 160, nullable: false),
                    origin = table.Column<string>(type: "text", nullable: false),
                    title = table.Column<string>(type: "character varying(200)", maxLength: 200, nullable: false),
                    description = table.Column<string>(type: "character varying(1000)", maxLength: 1000, nullable: true),
                    include_body = table.Column<bool>(type: "boolean", nullable: false),
                    include_children = table.Column<bool>(type: "boolean", nullable: false),
                    managed_source = table.Column<string>(type: "character varying(500)", maxLength: 500, nullable: true),
                    source_digest = table.Column<string>(type: "character varying(128)", maxLength: 128, nullable: true),
                    state = table.Column<string>(type: "text", nullable: false),
                    revision = table.Column<int>(type: "integer", nullable: false),
                    created_by = table.Column<Guid>(type: "uuid", nullable: false),
                    last_modified_by = table.Column<Guid>(type: "uuid", nullable: false),
                    created_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    last_modified_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_workspace_template", x => x.template_id);
                    table.UniqueConstraint("AK_workspace_template_tenant_id_template_id", x => new { x.tenant_id, x.template_id });
                    table.ForeignKey(
                        name: "FK_workspace_template_workspace_tenant_id_workspace_id",
                        columns: x => new { x.tenant_id, x.workspace_id },
                        principalTable: "workspace",
                        principalColumns: new[] { "tenant_id", "workspace_id" },
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateTable(
                name: "template_application",
                columns: table => new
                {
                    application_id = table.Column<Guid>(type: "uuid", nullable: false),
                    tenant_id = table.Column<Guid>(type: "uuid", nullable: false),
                    workspace_id = table.Column<Guid>(type: "uuid", nullable: false),
                    template_id = table.Column<Guid>(type: "uuid", nullable: false),
                    target_item_id = table.Column<Guid>(type: "uuid", nullable: false),
                    parent_item_id = table.Column<Guid>(type: "uuid", nullable: true),
                    requested_title = table.Column<string>(type: "character varying(200)", maxLength: 200, nullable: true),
                    mode = table.Column<string>(type: "text", nullable: false),
                    idempotency_key = table.Column<string>(type: "character varying(160)", maxLength: 160, nullable: false),
                    actor_id = table.Column<Guid>(type: "uuid", nullable: false),
                    state = table.Column<string>(type: "text", nullable: false),
                    created_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    expires_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    finalized_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_template_application", x => x.application_id);
                    table.UniqueConstraint("AK_template_application_tenant_id_application_id", x => new { x.tenant_id, x.application_id });
                    table.ForeignKey(
                        name: "FK_template_application_workspace_template_tenant_id_template_~",
                        columns: x => new { x.tenant_id, x.template_id },
                        principalTable: "workspace_template",
                        principalColumns: new[] { "tenant_id", "template_id" },
                        onDelete: ReferentialAction.Restrict);
                    table.ForeignKey(
                        name: "FK_template_application_workspace_tenant_id_workspace_id",
                        columns: x => new { x.tenant_id, x.workspace_id },
                        principalTable: "workspace",
                        principalColumns: new[] { "tenant_id", "workspace_id" },
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateTable(
                name: "template_operation",
                columns: table => new
                {
                    operation_id = table.Column<Guid>(type: "uuid", nullable: false),
                    tenant_id = table.Column<Guid>(type: "uuid", nullable: false),
                    workspace_id = table.Column<Guid>(type: "uuid", nullable: false),
                    template_id = table.Column<Guid>(type: "uuid", nullable: false),
                    kind = table.Column<string>(type: "text", nullable: false),
                    idempotency_key = table.Column<string>(type: "character varying(160)", maxLength: 160, nullable: false),
                    source_item_id = table.Column<Guid>(type: "uuid", nullable: true),
                    actor_id = table.Column<Guid>(type: "uuid", nullable: false),
                    draft_title = table.Column<string>(type: "character varying(200)", maxLength: 200, nullable: true),
                    draft_description = table.Column<string>(type: "character varying(1000)", maxLength: 1000, nullable: true),
                    managed_source = table.Column<string>(type: "character varying(500)", maxLength: 500, nullable: true),
                    source_digest = table.Column<string>(type: "character varying(128)", maxLength: 128, nullable: true),
                    state = table.Column<string>(type: "text", nullable: false),
                    created_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    expires_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    finalized_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_template_operation", x => x.operation_id);
                    table.UniqueConstraint("AK_template_operation_tenant_id_operation_id", x => new { x.tenant_id, x.operation_id });
                    table.ForeignKey(
                        name: "FK_template_operation_workspace_template_tenant_id_template_id",
                        columns: x => new { x.tenant_id, x.template_id },
                        principalTable: "workspace_template",
                        principalColumns: new[] { "tenant_id", "template_id" },
                        onDelete: ReferentialAction.Cascade);
                    table.ForeignKey(
                        name: "FK_template_operation_workspace_tenant_id_workspace_id",
                        columns: x => new { x.tenant_id, x.workspace_id },
                        principalTable: "workspace",
                        principalColumns: new[] { "tenant_id", "workspace_id" },
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateTable(
                name: "template_application_item",
                columns: table => new
                {
                    application_id = table.Column<Guid>(type: "uuid", nullable: false),
                    template_source_id = table.Column<Guid>(type: "uuid", nullable: false),
                    tenant_id = table.Column<Guid>(type: "uuid", nullable: false),
                    source_item_id = table.Column<Guid>(type: "uuid", nullable: false),
                    item_type = table.Column<string>(type: "character varying(64)", maxLength: 64, nullable: false),
                    target_item_id = table.Column<Guid>(type: "uuid", nullable: false),
                    is_root = table.Column<bool>(type: "boolean", nullable: false),
                    created = table.Column<bool>(type: "boolean", nullable: false),
                    body_required = table.Column<bool>(type: "boolean", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_template_application_item", x => new { x.application_id, x.template_source_id });
                    table.ForeignKey(
                        name: "FK_template_application_item_template_application_tenant_id_ap~",
                        columns: x => new { x.tenant_id, x.application_id },
                        principalTable: "template_application",
                        principalColumns: new[] { "tenant_id", "application_id" },
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateTable(
                name: "template_operation_item",
                columns: table => new
                {
                    operation_id = table.Column<Guid>(type: "uuid", nullable: false),
                    template_source_id = table.Column<Guid>(type: "uuid", nullable: false),
                    tenant_id = table.Column<Guid>(type: "uuid", nullable: false),
                    source_item_id = table.Column<Guid>(type: "uuid", nullable: true),
                    target_item_id = table.Column<Guid>(type: "uuid", nullable: false),
                    item_type = table.Column<string>(type: "character varying(64)", maxLength: 64, nullable: false),
                    body_required = table.Column<bool>(type: "boolean", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_template_operation_item", x => new { x.operation_id, x.template_source_id });
                    table.ForeignKey(
                        name: "FK_template_operation_item_template_operation_tenant_id_operat~",
                        columns: x => new { x.tenant_id, x.operation_id },
                        principalTable: "template_operation",
                        principalColumns: new[] { "tenant_id", "operation_id" },
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateIndex(
                name: "IX_item_tenant_id_template_id_template_source_id",
                table: "item",
                columns: new[] { "tenant_id", "template_id", "template_source_id" });

            migrationBuilder.CreateIndex(
                name: "IX_template_application_tenant_id_workspace_id_state_expires_at",
                table: "template_application",
                columns: new[] { "tenant_id", "workspace_id", "state", "expires_at" });

            migrationBuilder.CreateIndex(
                name: "IX_template_application_template_id_target_item_id",
                table: "template_application",
                columns: new[] { "template_id", "target_item_id" });

            migrationBuilder.CreateIndex(
                name: "IX_template_application_tenant_id_actor_id_idempotency_key",
                table: "template_application",
                columns: new[] { "tenant_id", "actor_id", "idempotency_key" },
                unique: true);

            migrationBuilder.CreateIndex(
                name: "IX_template_application_tenant_id_template_id",
                table: "template_application",
                columns: new[] { "tenant_id", "template_id" });

            migrationBuilder.CreateIndex(
                name: "IX_template_application_item_tenant_id_application_id",
                table: "template_application_item",
                columns: new[] { "tenant_id", "application_id" });

            migrationBuilder.CreateIndex(
                name: "IX_template_application_item_tenant_id_target_item_id",
                table: "template_application_item",
                columns: new[] { "tenant_id", "target_item_id" });

            migrationBuilder.CreateIndex(
                name: "IX_template_operation_tenant_id_workspace_id_state_expires_at",
                table: "template_operation",
                columns: new[] { "tenant_id", "workspace_id", "state", "expires_at" });

            migrationBuilder.CreateIndex(
                name: "IX_template_operation_tenant_id_actor_id_idempotency_key",
                table: "template_operation",
                columns: new[] { "tenant_id", "actor_id", "idempotency_key" },
                unique: true);

            migrationBuilder.CreateIndex(
                name: "IX_template_operation_tenant_id_template_id",
                table: "template_operation",
                columns: new[] { "tenant_id", "template_id" });

            migrationBuilder.CreateIndex(
                name: "IX_template_operation_item_tenant_id_operation_id",
                table: "template_operation_item",
                columns: new[] { "tenant_id", "operation_id" });

            migrationBuilder.CreateIndex(
                name: "IX_template_operation_item_tenant_id_source_item_id",
                table: "template_operation_item",
                columns: new[] { "tenant_id", "source_item_id" });

            migrationBuilder.CreateIndex(
                name: "IX_template_operation_item_tenant_id_target_item_id",
                table: "template_operation_item",
                columns: new[] { "tenant_id", "target_item_id" },
                unique: true);

            migrationBuilder.CreateIndex(
                name: "IX_workspace_template_tenant_id_workspace_id_stable_key",
                table: "workspace_template",
                columns: new[] { "tenant_id", "workspace_id", "stable_key" },
                unique: true);

            migrationBuilder.CreateIndex(
                name: "IX_workspace_template_workspace_id_state_last_modified_at",
                table: "workspace_template",
                columns: new[] { "workspace_id", "state", "last_modified_at" });

            migrationBuilder.AddForeignKey(
                name: "FK_item_workspace_template_tenant_id_template_id",
                table: "item",
                columns: new[] { "tenant_id", "template_id" },
                principalTable: "workspace_template",
                principalColumns: new[] { "tenant_id", "template_id" },
                onDelete: ReferentialAction.Restrict);

            Nix.Persistence.Migrations.TemplateSecuritySql.Apply(sql => migrationBuilder.Sql(sql));
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            Nix.Persistence.Migrations.TemplateSecuritySql.Revert(sql => migrationBuilder.Sql(sql));

            migrationBuilder.DropForeignKey(
                name: "FK_item_workspace_template_tenant_id_template_id",
                table: "item");

            migrationBuilder.DropTable(
                name: "template_application_item");

            migrationBuilder.DropTable(
                name: "template_operation_item");

            migrationBuilder.DropTable(
                name: "template_application");

            migrationBuilder.DropTable(
                name: "template_operation");

            migrationBuilder.DropTable(
                name: "workspace_template");

            migrationBuilder.DropIndex(
                name: "IX_item_tenant_id_template_id_template_source_id",
                table: "item");

            migrationBuilder.DropColumn(
                name: "can_manage_templates",
                table: "principal");

            migrationBuilder.DropColumn(
                name: "template_id",
                table: "item");

            migrationBuilder.DropColumn(
                name: "template_source_id",
                table: "item");
        }
    }
}
