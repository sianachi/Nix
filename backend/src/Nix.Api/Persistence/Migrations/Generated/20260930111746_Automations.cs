using System;
using Microsoft.EntityFrameworkCore.Migrations;
using Nix.Persistence.Migrations;

#nullable disable

namespace Nix.Persistence.Migrations.Generated
{
    /// <inheritdoc />
    public partial class AddAutomations : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.CreateTable(
                name: "automation_rule",
                columns: table => new
                {
                    id = table.Column<Guid>(type: "uuid", nullable: false),
                    tenant_id = table.Column<Guid>(type: "uuid", nullable: false),
                    workspace_id = table.Column<Guid>(type: "uuid", nullable: false),
                    owner_principal_id = table.Column<Guid>(type: "uuid", nullable: false),
                    name = table.Column<string>(type: "character varying(200)", maxLength: 200, nullable: false),
                    enabled = table.Column<bool>(type: "boolean", nullable: false),
                    scope_item_id = table.Column<Guid>(type: "uuid", nullable: true),
                    trigger_type = table.Column<string>(type: "character varying(32)", maxLength: 32, nullable: false),
                    watch_key = table.Column<string>(type: "character varying(128)", maxLength: 128, nullable: true),
                    trigger = table.Column<string>(type: "jsonb", nullable: false),
                    conditions = table.Column<string>(type: "jsonb", nullable: false, defaultValueSql: "'[]'::jsonb"),
                    actions = table.Column<string>(type: "jsonb", nullable: false),
                    schema_version = table.Column<short>(type: "smallint", nullable: false, defaultValue: (short)1),
                    revision = table.Column<long>(type: "bigint", nullable: false),
                    consecutive_failures = table.Column<int>(type: "integer", nullable: false, defaultValue: 0),
                    disabled_reason = table.Column<string>(type: "character varying(64)", maxLength: 64, nullable: true),
                    last_run_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true),
                    created_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    updated_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_automation_rule", x => x.id);
                    table.UniqueConstraint("AK_automation_rule_tenant_id_id", x => new { x.tenant_id, x.id });
                    table.CheckConstraint("automation_rule_bounded", "trigger_type IN ('schedule', 'date_arrives', 'property_changed') AND char_length(name) BETWEEN 1 AND 200 AND (trigger_type = 'property_changed') = (watch_key IS NOT NULL) AND jsonb_typeof(actions) = 'array' AND jsonb_typeof(conditions) = 'array' AND octet_length(trigger::text) <= 4096 AND octet_length(actions::text) <= 16384 AND octet_length(conditions::text) <= 8192 AND consecutive_failures >= 0");
                    table.ForeignKey(
                        name: "FK_automation_rule_item_tenant_id_scope_item_id",
                        columns: x => new { x.tenant_id, x.scope_item_id },
                        principalTable: "item",
                        principalColumns: new[] { "tenant_id", "id" },
                        onDelete: ReferentialAction.Cascade);
                    table.ForeignKey(
                        name: "FK_automation_rule_principal_tenant_id_owner_principal_id",
                        columns: x => new { x.tenant_id, x.owner_principal_id },
                        principalTable: "principal",
                        principalColumns: new[] { "tenant_id", "principal_id" },
                        onDelete: ReferentialAction.Cascade);
                    table.ForeignKey(
                        name: "FK_automation_rule_workspace_tenant_id_workspace_id",
                        columns: x => new { x.tenant_id, x.workspace_id },
                        principalTable: "workspace",
                        principalColumns: new[] { "tenant_id", "workspace_id" },
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateTable(
                name: "automation_item_state",
                columns: table => new
                {
                    tenant_id = table.Column<Guid>(type: "uuid", nullable: false),
                    rule_id = table.Column<Guid>(type: "uuid", nullable: false),
                    item_id = table.Column<Guid>(type: "uuid", nullable: false),
                    owner_principal_id = table.Column<Guid>(type: "uuid", nullable: false),
                    last_value_hash = table.Column<string>(type: "character varying(64)", maxLength: 64, nullable: true),
                    last_fired_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_automation_item_state", x => new { x.tenant_id, x.rule_id, x.item_id });
                    table.ForeignKey(
                        name: "FK_automation_item_state_automation_rule_tenant_id_rule_id",
                        columns: x => new { x.tenant_id, x.rule_id },
                        principalTable: "automation_rule",
                        principalColumns: new[] { "tenant_id", "id" },
                        onDelete: ReferentialAction.Cascade);
                    table.ForeignKey(
                        name: "FK_automation_item_state_item_tenant_id_item_id",
                        columns: x => new { x.tenant_id, x.item_id },
                        principalTable: "item",
                        principalColumns: new[] { "tenant_id", "id" },
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateTable(
                name: "automation_run",
                columns: table => new
                {
                    id = table.Column<Guid>(type: "uuid", nullable: false),
                    tenant_id = table.Column<Guid>(type: "uuid", nullable: false),
                    rule_id = table.Column<Guid>(type: "uuid", nullable: false),
                    owner_principal_id = table.Column<Guid>(type: "uuid", nullable: false),
                    workspace_id = table.Column<Guid>(type: "uuid", nullable: false),
                    item_id = table.Column<Guid>(type: "uuid", nullable: true),
                    trigger_key = table.Column<string>(type: "character varying(200)", maxLength: 200, nullable: false),
                    origin = table.Column<string>(type: "character varying(16)", maxLength: 16, nullable: false),
                    depth = table.Column<short>(type: "smallint", nullable: false),
                    status = table.Column<string>(type: "character varying(16)", maxLength: 16, nullable: false),
                    detail = table.Column<string>(type: "jsonb", nullable: true),
                    created_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_automation_run", x => x.id);
                    table.CheckConstraint("automation_run_bounded", "origin IN ('schedule', 'date', 'property', 'manual') AND status IN ('succeeded', 'noop', 'skipped', 'failed', 'throttled', 'suppressed') AND depth >= 0 AND char_length(trigger_key) <= 200 AND (detail IS NULL OR octet_length(detail::text) <= 2048)");
                    table.ForeignKey(
                        name: "FK_automation_run_automation_rule_tenant_id_rule_id",
                        columns: x => new { x.tenant_id, x.rule_id },
                        principalTable: "automation_rule",
                        principalColumns: new[] { "tenant_id", "id" },
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateIndex(
                name: "ix_automation_item_state_item",
                table: "automation_item_state",
                columns: new[] { "tenant_id", "item_id" });

            migrationBuilder.CreateIndex(
                name: "ix_automation_rule_owner",
                table: "automation_rule",
                columns: new[] { "tenant_id", "owner_principal_id", "workspace_id", "created_at" });

            migrationBuilder.CreateIndex(
                name: "ix_automation_rule_planned",
                table: "automation_rule",
                column: "id",
                filter: "enabled AND trigger_type IN ('schedule', 'date_arrives')");

            migrationBuilder.CreateIndex(
                name: "ix_automation_rule_property_watch",
                table: "automation_rule",
                columns: new[] { "tenant_id", "workspace_id" },
                filter: "enabled AND trigger_type = 'property_changed'");

            migrationBuilder.CreateIndex(
                name: "ix_automation_rule_scope_item",
                table: "automation_rule",
                columns: new[] { "tenant_id", "scope_item_id" });

            migrationBuilder.CreateIndex(
                name: "ix_automation_run_created_at",
                table: "automation_run",
                column: "created_at");

            migrationBuilder.CreateIndex(
                name: "ix_automation_run_rule_created",
                table: "automation_run",
                columns: new[] { "tenant_id", "rule_id", "created_at" },
                descending: new[] { false, false, true });

            migrationBuilder.CreateIndex(
                name: "ix_automation_run_rule_working",
                table: "automation_run",
                columns: new[] { "tenant_id", "rule_id", "created_at" },
                descending: new[] { false, false, true },
                filter: "status IN ('succeeded', 'noop', 'failed')");

            migrationBuilder.CreateIndex(
                name: "ux_automation_run_rule_trigger_key",
                table: "automation_run",
                columns: new[] { "tenant_id", "rule_id", "trigger_key" },
                unique: true);

            AutomationSecuritySql.Apply(sql => migrationBuilder.Sql(sql));
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            // Destructive: dropping the tables below deletes every automation rule, run and
            // per-item state. Revert first removes the automation sources' scheduled triggers.
            AutomationSecuritySql.Revert(sql => migrationBuilder.Sql(sql));

            migrationBuilder.DropTable(
                name: "automation_item_state");

            migrationBuilder.DropTable(
                name: "automation_run");

            migrationBuilder.DropTable(
                name: "automation_rule");
        }
    }
}
