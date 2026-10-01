using System;
using Microsoft.EntityFrameworkCore.Migrations;
using Nix.Persistence.Migrations;

#nullable disable

namespace Nix.Persistence.Migrations.Generated
{
    /// <inheritdoc />
    public partial class AddScheduling : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.CreateTable(
                name: "scheduled_trigger",
                columns: table => new
                {
                    id = table.Column<Guid>(type: "uuid", nullable: false),
                    tenant_id = table.Column<Guid>(type: "uuid", nullable: false),
                    workspace_id = table.Column<Guid>(type: "uuid", nullable: true),
                    principal_id = table.Column<Guid>(type: "uuid", nullable: false),
                    kind = table.Column<string>(type: "character varying(16)", maxLength: 16, nullable: false),
                    source_item_id = table.Column<Guid>(type: "uuid", nullable: true),
                    rule_id = table.Column<Guid>(type: "uuid", nullable: true),
                    fire_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    dedupe_key = table.Column<string>(type: "character varying(200)", maxLength: 200, nullable: false),
                    status = table.Column<string>(type: "character varying(16)", maxLength: 16, nullable: false),
                    lease_owner = table.Column<string>(type: "character varying(128)", maxLength: 128, nullable: true),
                    lease_until = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true),
                    attempts = table.Column<int>(type: "integer", nullable: false),
                    detail = table.Column<string>(type: "jsonb", nullable: true),
                    created_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    updated_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_scheduled_trigger", x => x.id);
                    table.CheckConstraint("scheduled_trigger_bounded", "kind IN ('reminder', 'automation', 'system') AND status IN ('pending', 'leased', 'fired', 'skipped', 'cancelled') AND attempts >= 0 AND char_length(dedupe_key) <= 200 AND (lease_owner IS NULL OR char_length(lease_owner) <= 128)");
                    table.ForeignKey(
                        name: "FK_scheduled_trigger_principal_tenant_id_principal_id",
                        columns: x => new { x.tenant_id, x.principal_id },
                        principalTable: "principal",
                        principalColumns: new[] { "tenant_id", "principal_id" },
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateIndex(
                name: "IX_scheduled_trigger_status_fire_at",
                table: "scheduled_trigger",
                columns: new[] { "status", "fire_at" });

            migrationBuilder.CreateIndex(
                name: "IX_scheduled_trigger_tenant_id_principal_id_dedupe_key",
                table: "scheduled_trigger",
                columns: new[] { "tenant_id", "principal_id", "dedupe_key" },
                unique: true);

            migrationBuilder.CreateIndex(
                name: "IX_scheduled_trigger_tenant_id_principal_id_kind_status_fire_at",
                table: "scheduled_trigger",
                columns: new[] { "tenant_id", "principal_id", "kind", "status", "fire_at" });

            SchedulingSecuritySql.Apply(sql => migrationBuilder.Sql(sql));
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            SchedulingSecuritySql.Revert(sql => migrationBuilder.Sql(sql));

            migrationBuilder.DropTable(
                name: "scheduled_trigger");
        }
    }
}
