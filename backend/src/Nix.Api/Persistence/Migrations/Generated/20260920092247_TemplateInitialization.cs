using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Nix.Persistence.Migrations.Generated
{
    /// <inheritdoc />
    public partial class TemplateInitialization : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<string>(
                name: "initialization",
                table: "workspace_template",
                type: "jsonb",
                nullable: true);

            migrationBuilder.AddColumn<string>(
                name: "draft_initialization",
                table: "template_operation",
                type: "jsonb",
                nullable: true);

            migrationBuilder.AddColumn<string>(
                name: "request_fingerprint",
                table: "template_application",
                type: "character varying(128)",
                maxLength: 128,
                nullable: true);

            migrationBuilder.AddColumn<string>(
                name: "resolved_inputs",
                table: "template_application",
                type: "jsonb",
                nullable: true);

            migrationBuilder.AddColumn<int>(
                name: "template_revision",
                table: "template_application",
                type: "integer",
                nullable: false,
                defaultValue: 0);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropColumn(
                name: "initialization",
                table: "workspace_template");

            migrationBuilder.DropColumn(
                name: "draft_initialization",
                table: "template_operation");

            migrationBuilder.DropColumn(
                name: "request_fingerprint",
                table: "template_application");

            migrationBuilder.DropColumn(
                name: "resolved_inputs",
                table: "template_application");

            migrationBuilder.DropColumn(
                name: "template_revision",
                table: "template_application");
        }
    }
}
