using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Nix.Persistence.Migrations.Generated
{
    /// <inheritdoc />
    public partial class RabbitTemplateImports : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<string>(
                name: "managed_source",
                table: "document_import",
                type: "character varying(500)",
                maxLength: 500,
                nullable: true);

            migrationBuilder.AddColumn<string>(
                name: "purpose",
                table: "document_import",
                type: "character varying(32)",
                maxLength: 32,
                nullable: false,
                defaultValue: "workspace");

            migrationBuilder.AddColumn<string>(
                name: "template_digest",
                table: "document_import",
                type: "character varying(64)",
                maxLength: 64,
                nullable: true);

            migrationBuilder.AddColumn<Guid>(
                name: "template_id",
                table: "document_import",
                type: "uuid",
                nullable: true);

            migrationBuilder.AddColumn<Guid>(
                name: "template_operation_id",
                table: "document_import",
                type: "uuid",
                nullable: true);

            migrationBuilder.AddColumn<string>(
                name: "template_preview",
                table: "document_import",
                type: "jsonb",
                nullable: true);

            migrationBuilder.AddColumn<string>(
                name: "template_stable_key",
                table: "document_import",
                type: "character varying(160)",
                maxLength: 160,
                nullable: true);

            migrationBuilder.AddColumn<bool>(
                name: "template_unchanged",
                table: "document_import",
                type: "boolean",
                nullable: true);

            migrationBuilder.AddColumn<string>(
                name: "template_written_target_item_ids",
                table: "document_import",
                type: "jsonb",
                nullable: true);

            migrationBuilder.DropCheckConstraint(
                name: "CK_file_upload_purpose",
                table: "file_upload");

            migrationBuilder.AddCheckConstraint(
                name: "CK_file_upload_purpose",
                table: "file_upload",
                sql: "purpose IN ('file', 'document_import', 'template_import')");

            migrationBuilder.DropCheckConstraint(
                name: "CK_document_import_status",
                table: "document_import");

            migrationBuilder.AddCheckConstraint(
                name: "CK_document_import_status",
                table: "document_import",
                sql: "status IN ('pending_upload', 'preview_queued', 'preview_ready', 'commit_queued', 'staging', 'staged', 'completed', 'cancelled', 'failed')");

            migrationBuilder.AddCheckConstraint(
                name: "CK_document_import_purpose",
                table: "document_import",
                sql: "purpose IN ('workspace', 'template_user', 'template_managed') AND ((purpose = 'template_managed') = (managed_source IS NOT NULL)) AND (purpose = 'workspace' OR parent_id IS NULL)");

            migrationBuilder.AddCheckConstraint(
                name: "CK_document_import_template",
                table: "document_import",
                sql: "(purpose = 'workspace' AND template_preview IS NULL AND template_operation_id IS NULL AND template_id IS NULL AND template_stable_key IS NULL AND template_digest IS NULL AND template_unchanged IS NULL AND template_written_target_item_ids IS NULL) OR (purpose <> 'workspace' AND root_item_id IS NULL AND (template_digest IS NULL OR template_digest ~ '^[0-9a-f]{64}$') AND (template_written_target_item_ids IS NULL OR jsonb_typeof(template_written_target_item_ids) = 'array'))");

            migrationBuilder.CreateIndex(
                name: "IX_document_import_tenant_id_template_id",
                table: "document_import",
                columns: new[] { "tenant_id", "template_id" });

            migrationBuilder.CreateIndex(
                name: "IX_document_import_tenant_id_template_operation_id",
                table: "document_import",
                columns: new[] { "tenant_id", "template_operation_id" });

            WorkerExecutionFenceSecuritySql.Apply(sql => migrationBuilder.Sql(sql));
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            WorkerExecutionFenceSecuritySql.Revert(sql => migrationBuilder.Sql(sql));

            migrationBuilder.Sql("DELETE FROM file_upload WHERE purpose = 'template_import';");

            migrationBuilder.DropCheckConstraint(
                name: "CK_document_import_template",
                table: "document_import");

            migrationBuilder.DropCheckConstraint(
                name: "CK_document_import_purpose",
                table: "document_import");

            migrationBuilder.DropCheckConstraint(
                name: "CK_document_import_status",
                table: "document_import");

            migrationBuilder.AddCheckConstraint(
                name: "CK_document_import_status",
                table: "document_import",
                sql: "status IN ('pending_upload', 'preview_queued', 'preview_ready', 'commit_queued', 'staging', 'completed', 'cancelled', 'failed')");

            migrationBuilder.DropCheckConstraint(
                name: "CK_file_upload_purpose",
                table: "file_upload");

            migrationBuilder.AddCheckConstraint(
                name: "CK_file_upload_purpose",
                table: "file_upload",
                sql: "purpose IN ('file', 'document_import')");

            migrationBuilder.DropIndex(
                name: "IX_document_import_tenant_id_template_id",
                table: "document_import");

            migrationBuilder.DropIndex(
                name: "IX_document_import_tenant_id_template_operation_id",
                table: "document_import");

            migrationBuilder.DropColumn(
                name: "managed_source",
                table: "document_import");

            migrationBuilder.DropColumn(
                name: "purpose",
                table: "document_import");

            migrationBuilder.DropColumn(
                name: "template_digest",
                table: "document_import");

            migrationBuilder.DropColumn(
                name: "template_id",
                table: "document_import");

            migrationBuilder.DropColumn(
                name: "template_operation_id",
                table: "document_import");

            migrationBuilder.DropColumn(
                name: "template_preview",
                table: "document_import");

            migrationBuilder.DropColumn(
                name: "template_stable_key",
                table: "document_import");

            migrationBuilder.DropColumn(
                name: "template_unchanged",
                table: "document_import");

            migrationBuilder.DropColumn(
                name: "template_written_target_item_ids",
                table: "document_import");
        }
    }
}
