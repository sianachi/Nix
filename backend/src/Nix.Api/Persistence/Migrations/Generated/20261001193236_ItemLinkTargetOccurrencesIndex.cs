using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Nix.Persistence.Migrations.Generated
{
    /// <inheritdoc />
    public partial class ItemLinkTargetOccurrencesIndex : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropIndex(
                name: "ix_item_link_target",
                table: "item_link");

            migrationBuilder.CreateIndex(
                name: "ix_item_link_target_occurrences",
                table: "item_link",
                columns: new[] { "tenant_id", "target_item_id", "occurrences", "source_item_id" },
                descending: new[] { false, false, true, false });
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropIndex(
                name: "ix_item_link_target_occurrences",
                table: "item_link");

            migrationBuilder.CreateIndex(
                name: "ix_item_link_target",
                table: "item_link",
                columns: new[] { "tenant_id", "target_item_id" });
        }
    }
}
