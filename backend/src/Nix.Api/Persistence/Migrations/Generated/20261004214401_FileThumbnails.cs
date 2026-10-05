using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Nix.Persistence.Migrations.Generated
{
    /// <inheritdoc />
    public partial class FileThumbnails : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<int>(
                name: "thumbnail_bytes",
                table: "file_version",
                type: "integer",
                nullable: true);

            migrationBuilder.AddColumn<int>(
                name: "thumbnail_height",
                table: "file_version",
                type: "integer",
                nullable: true);

            migrationBuilder.AddColumn<int>(
                name: "thumbnail_width",
                table: "file_version",
                type: "integer",
                nullable: true);

            // All three are set together or not at all. The bounds mirror the worker's thumbnail
            // package (480 pixels on the longest side) and the 2 MiB ceiling Core validates.
            migrationBuilder.AddCheckConstraint(
                "CK_file_version_thumbnail",
                "file_version",
                "(thumbnail_width IS NULL AND thumbnail_height IS NULL AND thumbnail_bytes IS NULL) OR (thumbnail_width IS NOT NULL AND thumbnail_height IS NOT NULL AND thumbnail_bytes IS NOT NULL AND thumbnail_width BETWEEN 1 AND 480 AND thumbnail_height BETWEEN 1 AND 480 AND thumbnail_bytes BETWEEN 1 AND 2097152)");
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropCheckConstraint(
                name: "CK_file_version_thumbnail",
                table: "file_version");

            migrationBuilder.DropColumn(
                name: "thumbnail_bytes",
                table: "file_version");

            migrationBuilder.DropColumn(
                name: "thumbnail_height",
                table: "file_version");

            migrationBuilder.DropColumn(
                name: "thumbnail_width",
                table: "file_version");
        }
    }
}
