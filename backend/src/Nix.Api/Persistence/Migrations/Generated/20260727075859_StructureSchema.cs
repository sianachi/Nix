using Microsoft.EntityFrameworkCore.Migrations;
// ReSharper disable All

#nullable disable

namespace Nix.Persistence.Migrations.Generated
{
    /// <inheritdoc />
    public partial class StructureSchema : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<string>(
                name: "schema",
                table: "item",
                type: "jsonb",
                nullable: true);

            migrationBuilder.AddColumn<string>(
                name: "views",
                table: "item",
                type: "jsonb",
                nullable: true);

            // Payload bounds on the two new columns, the expression index that makes ordering a
            // folder by title a query rather than a scan, and the partial index over the few items
            // that declare a schema. Hand-authored and kept outside this folder so a re-scaffold
            // cannot delete it; if this call goes missing, the columns are unbounded and the
            // cascade reads fall back to heap fetches per ancestor.
            StructureSecuritySql.Apply(sql => migrationBuilder.Sql(sql));
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropColumn(
                name: "schema",
                table: "item");

            migrationBuilder.DropColumn(
                name: "views",
                table: "item");
        }
    }
}
