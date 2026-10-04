using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Nix.Persistence.Migrations.Generated
{
    /// <inheritdoc />
    public partial class ItemProtection : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<string>(
                name: "managed_by",
                table: "item",
                type: "text",
                nullable: true);

            migrationBuilder.AddColumn<bool>(
                name: "no_children",
                table: "item",
                type: "boolean",
                nullable: false,
                defaultValue: false);

            migrationBuilder.AddColumn<bool>(
                name: "no_delete",
                table: "item",
                type: "boolean",
                nullable: false,
                defaultValue: false);

            migrationBuilder.CreateIndex(
                name: "ix_item_no_delete",
                table: "item",
                columns: new[] { "tenant_id", "id" },
                filter: "no_delete");

            Nix.Persistence.Migrations.ItemProtectionSecuritySql.Apply(sql => migrationBuilder.Sql(sql));
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            Nix.Persistence.Migrations.ItemProtectionSecuritySql.Revert(sql => migrationBuilder.Sql(sql));

            migrationBuilder.DropIndex(
                name: "ix_item_no_delete",
                table: "item");

            migrationBuilder.DropColumn(
                name: "managed_by",
                table: "item");

            migrationBuilder.DropColumn(
                name: "no_children",
                table: "item");

            migrationBuilder.DropColumn(
                name: "no_delete",
                table: "item");
        }
    }
}
