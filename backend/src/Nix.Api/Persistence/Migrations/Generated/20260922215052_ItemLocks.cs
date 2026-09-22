using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Nix.Persistence.Migrations.Generated
{
    // [SEC] Adds item_lock and item_unlock, two new tenant-isolated tables that gate who may read an
    // item's body (RLS policy, grant split and bounds applied below via ItemLockSecuritySql). An
    // authorization change: requires security review and owner approval before merge.
    /// <inheritdoc />
    public partial class ItemLocks : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.CreateTable(
                name: "item_lock",
                columns: table => new
                {
                    item_id = table.Column<Guid>(type: "uuid", nullable: false),
                    tenant_id = table.Column<Guid>(type: "uuid", nullable: false),
                    password_hash = table.Column<string>(type: "text", nullable: false),
                    locked_by = table.Column<Guid>(type: "uuid", nullable: false),
                    locked_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_item_lock", x => x.item_id);
                    table.UniqueConstraint("AK_item_lock_tenant_id_item_id", x => new { x.tenant_id, x.item_id });
                    table.ForeignKey(
                        name: "FK_item_lock_item_tenant_id_item_id",
                        columns: x => new { x.tenant_id, x.item_id },
                        principalTable: "item",
                        principalColumns: new[] { "tenant_id", "id" },
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateTable(
                name: "item_unlock",
                columns: table => new
                {
                    item_id = table.Column<Guid>(type: "uuid", nullable: false),
                    credential_id = table.Column<Guid>(type: "uuid", nullable: false),
                    tenant_id = table.Column<Guid>(type: "uuid", nullable: false),
                    principal_id = table.Column<Guid>(type: "uuid", nullable: false),
                    expires_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_item_unlock", x => new { x.item_id, x.credential_id });
                    table.ForeignKey(
                        name: "FK_item_unlock_item_lock_tenant_id_item_id",
                        columns: x => new { x.tenant_id, x.item_id },
                        principalTable: "item_lock",
                        principalColumns: new[] { "tenant_id", "item_id" },
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateIndex(
                name: "IX_item_unlock_tenant_id_item_id",
                table: "item_unlock",
                columns: new[] { "tenant_id", "item_id" });

            ItemLockSecuritySql.Apply(sql => migrationBuilder.Sql(sql));
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            ItemLockSecuritySql.Revert(sql => migrationBuilder.Sql(sql));

            migrationBuilder.DropTable(
                name: "item_unlock");

            migrationBuilder.DropTable(
                name: "item_lock");
        }
    }
}
