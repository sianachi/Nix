using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Nix.Persistence.Migrations.Generated
{
    /// <inheritdoc />
    public partial class TemplateCaptureSnapshotFence : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<bool>(
                name: "check_head",
                table: "template_operation_item",
                type: "boolean",
                nullable: false,
                defaultValue: false);

            migrationBuilder.AddColumn<Guid>(
                name: "expected_doc_id",
                table: "template_operation_item",
                type: "uuid",
                nullable: true);

            migrationBuilder.AddColumn<long>(
                name: "expected_head_seq",
                table: "template_operation_item",
                type: "bigint",
                nullable: true);

            migrationBuilder.AddColumn<string>(
                name: "capture_fingerprint",
                table: "template_operation",
                type: "character varying(64)",
                maxLength: 64,
                nullable: true);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropColumn(
                name: "check_head",
                table: "template_operation_item");

            migrationBuilder.DropColumn(
                name: "expected_doc_id",
                table: "template_operation_item");

            migrationBuilder.DropColumn(
                name: "expected_head_seq",
                table: "template_operation_item");

            migrationBuilder.DropColumn(
                name: "capture_fingerprint",
                table: "template_operation");
        }
    }
}
