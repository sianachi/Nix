using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Nix.Persistence.Migrations.Generated;

/// <inheritdoc />
public partial class RabbitDocumentImports : Migration
{
    /// <inheritdoc />
    protected override void Up(MigrationBuilder migrationBuilder)
    {
        migrationBuilder.AddColumn<string>(
            name: "purpose",
            table: "file_upload",
            type: "character varying(32)",
            maxLength: 32,
            nullable: false,
            defaultValue: "file");

        migrationBuilder.AddCheckConstraint(
            name: "CK_file_upload_purpose",
            table: "file_upload",
            sql: "purpose IN ('file', 'document_import')");

        migrationBuilder.CreateTable(
            name: "document_import",
            columns: table => new
            {
                import_id = table.Column<Guid>(type: "uuid", nullable: false),
                tenant_id = table.Column<Guid>(type: "uuid", nullable: false),
                workspace_id = table.Column<Guid>(type: "uuid", nullable: false),
                actor_id = table.Column<Guid>(type: "uuid", nullable: false),
                upload_id = table.Column<Guid>(type: "uuid", nullable: false),
                parent_id = table.Column<Guid>(type: "uuid", nullable: true),
                format = table.Column<string>(type: "character varying(32)", maxLength: 32, nullable: false),
                title = table.Column<string>(type: "character varying(500)", maxLength: 500, nullable: false),
                idempotency_key = table.Column<string>(type: "character varying(160)", maxLength: 160, nullable: false),
                status = table.Column<string>(type: "character varying(32)", maxLength: 32, nullable: false),
                preview_job_id = table.Column<Guid>(type: "uuid", nullable: true),
                commit_job_id = table.Column<Guid>(type: "uuid", nullable: true),
                plan_object_key = table.Column<string>(type: "character varying(512)", maxLength: 512, nullable: false),
                plan_sha256 = table.Column<string>(type: "character varying(64)", maxLength: 64, nullable: true),
                plan_byte_length = table.Column<long>(type: "bigint", nullable: true),
                source_sha256 = table.Column<string>(type: "character varying(64)", maxLength: 64, nullable: true),
                item_count = table.Column<int>(type: "integer", nullable: true),
                asset_count = table.Column<int>(type: "integer", nullable: true),
                loss = table.Column<string>(type: "jsonb", nullable: true),
                omissions = table.Column<string>(type: "jsonb", nullable: true),
                root_item_id = table.Column<Guid>(type: "uuid", nullable: true),
                failure_code = table.Column<string>(type: "character varying(80)", maxLength: 80, nullable: true),
                expires_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                created_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                updated_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                completed_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true),
            },
            constraints: table =>
            {
                table.PrimaryKey("PK_document_import", value => value.import_id);
                table.UniqueConstraint("AK_document_import_tenant_id_import_id", value => new { value.tenant_id, value.import_id });
                table.ForeignKey(
                    name: "FK_document_import_file_upload_tenant_id_upload_id",
                    columns: value => new { value.tenant_id, value.upload_id },
                    principalTable: "file_upload",
                    principalColumns: new[] { "tenant_id", "upload_id" },
                    onDelete: ReferentialAction.Cascade);
                table.ForeignKey(
                    name: "FK_document_import_item_tenant_id_root_item_id",
                    columns: value => new { value.tenant_id, value.root_item_id },
                    principalTable: "item",
                    principalColumns: new[] { "tenant_id", "id" },
                    onDelete: ReferentialAction.Restrict);
                table.ForeignKey(
                    name: "FK_document_import_worker_job_tenant_id_commit_job_id",
                    columns: value => new { value.tenant_id, value.commit_job_id },
                    principalTable: "worker_job",
                    principalColumns: new[] { "tenant_id", "job_id" },
                    onDelete: ReferentialAction.Restrict);
                table.ForeignKey(
                    name: "FK_document_import_worker_job_tenant_id_preview_job_id",
                    columns: value => new { value.tenant_id, value.preview_job_id },
                    principalTable: "worker_job",
                    principalColumns: new[] { "tenant_id", "job_id" },
                    onDelete: ReferentialAction.Restrict);
                table.ForeignKey(
                    name: "FK_document_import_workspace_tenant_id_workspace_id",
                    columns: value => new { value.tenant_id, value.workspace_id },
                    principalTable: "workspace",
                    principalColumns: new[] { "tenant_id", "workspace_id" },
                    onDelete: ReferentialAction.Cascade);
            });

        migrationBuilder.CreateTable(
            name: "document_import_item",
            columns: table => new
            {
                import_id = table.Column<Guid>(type: "uuid", nullable: false),
                source_id = table.Column<string>(type: "character varying(160)", maxLength: 160, nullable: false),
                tenant_id = table.Column<Guid>(type: "uuid", nullable: false),
                parent_source_id = table.Column<string>(type: "character varying(160)", maxLength: 160, nullable: true),
                target_item_id = table.Column<Guid>(type: "uuid", nullable: false),
                item_type = table.Column<string>(type: "character varying(64)", maxLength: 64, nullable: false),
                final_lifecycle_state = table.Column<string>(type: "character varying(16)", maxLength: 16, nullable: false),
                body_required = table.Column<bool>(type: "boolean", nullable: false),
                file_version_id = table.Column<Guid>(type: "uuid", nullable: true),
                object_key = table.Column<string>(type: "character varying(512)", maxLength: 512, nullable: true),
                object_ready = table.Column<bool>(type: "boolean", nullable: false),
            },
            constraints: table =>
            {
                table.PrimaryKey("PK_document_import_item", value => new { value.import_id, value.source_id });
                table.ForeignKey(
                    name: "FK_document_import_item_document_import_tenant_id_import_id",
                    columns: value => new { value.tenant_id, value.import_id },
                    principalTable: "document_import",
                    principalColumns: new[] { "tenant_id", "import_id" },
                    onDelete: ReferentialAction.Cascade);
                table.ForeignKey(
                    name: "FK_document_import_item_file_version_tenant_id_file_version_id",
                    columns: value => new { value.tenant_id, value.file_version_id },
                    principalTable: "file_version",
                    principalColumns: new[] { "tenant_id", "file_version_id" },
                    onDelete: ReferentialAction.Cascade);
                table.ForeignKey(
                    name: "FK_document_import_item_item_tenant_id_target_item_id",
                    columns: value => new { value.tenant_id, value.target_item_id },
                    principalTable: "item",
                    principalColumns: new[] { "tenant_id", "id" },
                    onDelete: ReferentialAction.Cascade);
            });

        migrationBuilder.CreateIndex(
            name: "IX_document_import_status_expires_at",
            table: "document_import",
            columns: new[] { "status", "expires_at" });
        migrationBuilder.CreateIndex(
            name: "IX_document_import_tenant_id_actor_id_idempotency_key",
            table: "document_import",
            columns: new[] { "tenant_id", "actor_id", "idempotency_key" },
            unique: true);
        migrationBuilder.CreateIndex(
            name: "IX_document_import_tenant_id_commit_job_id",
            table: "document_import",
            columns: new[] { "tenant_id", "commit_job_id" });
        migrationBuilder.CreateIndex(
            name: "IX_document_import_tenant_id_preview_job_id",
            table: "document_import",
            columns: new[] { "tenant_id", "preview_job_id" });
        migrationBuilder.CreateIndex(
            name: "IX_document_import_tenant_id_root_item_id",
            table: "document_import",
            columns: new[] { "tenant_id", "root_item_id" });
        migrationBuilder.CreateIndex(
            name: "IX_document_import_tenant_id_upload_id",
            table: "document_import",
            columns: new[] { "tenant_id", "upload_id" });
        migrationBuilder.CreateIndex(
            name: "IX_document_import_tenant_id_workspace_id",
            table: "document_import",
            columns: new[] { "tenant_id", "workspace_id" });
        migrationBuilder.CreateIndex(
            name: "IX_document_import_item_tenant_id_import_id",
            table: "document_import_item",
            columns: new[] { "tenant_id", "import_id" });
        migrationBuilder.CreateIndex(
            name: "IX_document_import_item_tenant_id_file_version_id",
            table: "document_import_item",
            columns: new[] { "tenant_id", "file_version_id" });
        migrationBuilder.CreateIndex(
            name: "IX_document_import_item_tenant_id_target_item_id",
            table: "document_import_item",
            columns: new[] { "tenant_id", "target_item_id" },
            unique: true);

        migrationBuilder.AddCheckConstraint(
            name: "CK_document_import_status",
            table: "document_import",
            sql: "status IN ('pending_upload', 'preview_queued', 'preview_ready', 'commit_queued', 'staging', 'completed', 'cancelled', 'failed')");
        migrationBuilder.AddCheckConstraint(
            name: "CK_document_import_format",
            table: "document_import",
            sql: "format IN ('nix', 'markdown', 'txt', 'docx', 'pdf')");
        migrationBuilder.AddCheckConstraint(
            name: "CK_document_import_counts",
            table: "document_import",
            sql: "(item_count IS NULL OR item_count BETWEEN 1 AND 10000) AND (asset_count IS NULL OR asset_count BETWEEN 0 AND 10000) AND (plan_byte_length IS NULL OR plan_byte_length BETWEEN 1 AND 104857600)");
        migrationBuilder.AddCheckConstraint(
            name: "CK_document_import_digests",
            table: "document_import",
            sql: "(plan_sha256 IS NULL OR plan_sha256 ~ '^[0-9a-f]{64}$') AND (source_sha256 IS NULL OR source_sha256 ~ '^[0-9a-f]{64}$')");
        migrationBuilder.AddCheckConstraint(
            name: "CK_document_import_item_lifecycle",
            table: "document_import_item",
            sql: "final_lifecycle_state IN ('active', 'deleted')");
        migrationBuilder.AddCheckConstraint(
            name: "CK_document_import_item_file",
            table: "document_import_item",
            sql: "(item_type = 'file') = (file_version_id IS NOT NULL AND object_key IS NOT NULL) AND (item_type <> 'file' OR NOT body_required)");

        DocumentImportSecuritySql.Apply(sql => migrationBuilder.Sql(sql));
    }

    /// <inheritdoc />
    protected override void Down(MigrationBuilder migrationBuilder)
    {
        DocumentImportSecuritySql.Revert(sql => migrationBuilder.Sql(sql));
        migrationBuilder.DropTable(name: "document_import_item");
        migrationBuilder.DropTable(name: "document_import");
        migrationBuilder.DropCheckConstraint(name: "CK_file_upload_purpose", table: "file_upload");
        migrationBuilder.DropColumn(name: "purpose", table: "file_upload");
    }
}
