using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Nix.Persistence.Migrations.Generated
{
    /// <inheritdoc />
    public partial class UniversalFileItems : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.CreateTable(
                name: "file_upload",
                columns: table => new
                {
                    upload_id = table.Column<Guid>(type: "uuid", nullable: false),
                    tenant_id = table.Column<Guid>(type: "uuid", nullable: false),
                    workspace_id = table.Column<Guid>(type: "uuid", nullable: false),
                    parent_id = table.Column<Guid>(type: "uuid", nullable: true),
                    target_item_id = table.Column<Guid>(type: "uuid", nullable: true),
                    actor_id = table.Column<Guid>(type: "uuid", nullable: false),
                    idempotency_key = table.Column<string>(type: "character varying(160)", maxLength: 160, nullable: false),
                    file_name = table.Column<string>(type: "character varying(255)", maxLength: 255, nullable: false),
                    declared_media_type = table.Column<string>(type: "character varying(160)", maxLength: 160, nullable: false),
                    declared_byte_length = table.Column<long>(type: "bigint", nullable: false),
                    object_key = table.Column<string>(type: "character varying(512)", maxLength: 512, nullable: false),
                    status = table.Column<string>(type: "character varying(32)", maxLength: 32, nullable: false),
                    failure_code = table.Column<string>(type: "character varying(80)", maxLength: 80, nullable: true),
                    published_item_id = table.Column<Guid>(type: "uuid", nullable: true),
                    expires_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    created_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    updated_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_file_upload", x => x.upload_id);
                    table.UniqueConstraint("AK_file_upload_tenant_id_upload_id", x => new { x.tenant_id, x.upload_id });
                    table.ForeignKey(
                        name: "FK_file_upload_item_tenant_id_target_item_id",
                        columns: x => new { x.tenant_id, x.target_item_id },
                        principalTable: "item",
                        principalColumns: new[] { "tenant_id", "id" },
                        onDelete: ReferentialAction.Restrict);
                    table.ForeignKey(
                        name: "FK_file_upload_workspace_tenant_id_workspace_id",
                        columns: x => new { x.tenant_id, x.workspace_id },
                        principalTable: "workspace",
                        principalColumns: new[] { "tenant_id", "workspace_id" },
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateTable(
                name: "file_version",
                columns: table => new
                {
                    file_version_id = table.Column<Guid>(type: "uuid", nullable: false),
                    tenant_id = table.Column<Guid>(type: "uuid", nullable: false),
                    workspace_id = table.Column<Guid>(type: "uuid", nullable: false),
                    item_id = table.Column<Guid>(type: "uuid", nullable: false),
                    version = table.Column<int>(type: "integer", nullable: false),
                    object_key = table.Column<string>(type: "character varying(512)", maxLength: 512, nullable: false),
                    file_name = table.Column<string>(type: "character varying(255)", maxLength: 255, nullable: false),
                    media_type = table.Column<string>(type: "character varying(160)", maxLength: 160, nullable: false),
                    byte_length = table.Column<long>(type: "bigint", nullable: false),
                    sha256 = table.Column<string>(type: "character varying(64)", maxLength: 64, nullable: false),
                    pixel_width = table.Column<int>(type: "integer", nullable: true),
                    pixel_height = table.Column<int>(type: "integer", nullable: true),
                    previewable = table.Column<bool>(type: "boolean", nullable: false),
                    created_by = table.Column<Guid>(type: "uuid", nullable: false),
                    created_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_file_version", x => x.file_version_id);
                    table.UniqueConstraint("AK_file_version_tenant_id_file_version_id", x => new { x.tenant_id, x.file_version_id });
                    table.UniqueConstraint("AK_file_version_tenant_id_item_id_file_version_id", x => new { x.tenant_id, x.item_id, x.file_version_id });
                    table.ForeignKey(
                        name: "FK_file_version_item_tenant_id_item_id",
                        columns: x => new { x.tenant_id, x.item_id },
                        principalTable: "item",
                        principalColumns: new[] { "tenant_id", "id" },
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateTable(
                name: "file_body",
                columns: table => new
                {
                    item_id = table.Column<Guid>(type: "uuid", nullable: false),
                    tenant_id = table.Column<Guid>(type: "uuid", nullable: false),
                    workspace_id = table.Column<Guid>(type: "uuid", nullable: false),
                    current_version_id = table.Column<Guid>(type: "uuid", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_file_body", x => x.item_id);
                    table.UniqueConstraint("AK_file_body_tenant_id_item_id", x => new { x.tenant_id, x.item_id });
                    table.ForeignKey(
                        name: "FK_file_body_file_version_tenant_id_item_id_current_version_id",
                        columns: x => new { x.tenant_id, x.item_id, x.current_version_id },
                        principalTable: "file_version",
                        principalColumns: new[] { "tenant_id", "item_id", "file_version_id" },
                        onDelete: ReferentialAction.Restrict);
                    table.ForeignKey(
                        name: "FK_file_body_item_tenant_id_item_id",
                        columns: x => new { x.tenant_id, x.item_id },
                        principalTable: "item",
                        principalColumns: new[] { "tenant_id", "id" },
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateIndex(
                name: "IX_file_body_tenant_id_item_id_current_version_id",
                table: "file_body",
                columns: new[] { "tenant_id", "item_id", "current_version_id" });

            migrationBuilder.CreateIndex(
                name: "IX_file_upload_status_expires_at",
                table: "file_upload",
                columns: new[] { "status", "expires_at" });

            migrationBuilder.CreateIndex(
                name: "IX_file_upload_tenant_id_actor_id_idempotency_key",
                table: "file_upload",
                columns: new[] { "tenant_id", "actor_id", "idempotency_key" },
                unique: true);

            migrationBuilder.CreateIndex(
                name: "IX_file_upload_tenant_id_target_item_id",
                table: "file_upload",
                columns: new[] { "tenant_id", "target_item_id" });

            migrationBuilder.CreateIndex(
                name: "IX_file_upload_tenant_id_workspace_id",
                table: "file_upload",
                columns: new[] { "tenant_id", "workspace_id" });

            migrationBuilder.CreateIndex(
                name: "IX_file_version_tenant_id_item_id_version",
                table: "file_version",
                columns: new[] { "tenant_id", "item_id", "version" },
                unique: true);

            migrationBuilder.CreateIndex(
                name: "IX_file_version_tenant_id_object_key",
                table: "file_version",
                columns: new[] { "tenant_id", "object_key" },
                unique: true);

            migrationBuilder.AddCheckConstraint("CK_file_upload_byte_length", "file_upload", "declared_byte_length >= 0 AND declared_byte_length <= 104857600");
            migrationBuilder.AddCheckConstraint("CK_file_upload_status", "file_upload", "status IN ('pending_upload', 'inspection_queued', 'completed', 'cancelled', 'failed')");
            migrationBuilder.AddCheckConstraint("CK_file_version_byte_length", "file_version", "byte_length >= 0 AND byte_length <= 104857600");
            migrationBuilder.AddCheckConstraint("CK_file_version_sha256", "file_version", "sha256 ~ '^[0-9a-f]{64}$'");
            migrationBuilder.AddCheckConstraint("CK_file_version_dimensions", "file_version", "(pixel_width IS NULL AND pixel_height IS NULL) OR (pixel_width > 0 AND pixel_height > 0 AND pixel_width::bigint * pixel_height::bigint <= 1000000000 AND (NOT previewable OR pixel_width::bigint * pixel_height::bigint <= 40000000))");
            Nix.Persistence.Migrations.FileSecuritySql.Apply(sql => migrationBuilder.Sql(sql));
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            Nix.Persistence.Migrations.FileSecuritySql.Revert(sql => migrationBuilder.Sql(sql));
            migrationBuilder.DropTable(
                name: "file_body");

            migrationBuilder.DropTable(
                name: "file_upload");

            migrationBuilder.DropTable(
                name: "file_version");
        }
    }
}
