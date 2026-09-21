using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Nix.Persistence.Migrations.Generated
{
    /// <inheritdoc />
    public partial class DocumentImportFileVersions : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.CreateTable(
                name: "document_import_file_version",
                columns: table => new
                {
                    transfer_id = table.Column<Guid>(type: "uuid", nullable: false),
                    tenant_id = table.Column<Guid>(type: "uuid", nullable: false),
                    import_id = table.Column<Guid>(type: "uuid", nullable: false),
                    source_item_id = table.Column<string>(type: "character varying(160)", maxLength: 160, nullable: false),
                    target_item_id = table.Column<Guid>(type: "uuid", nullable: false),
                    file_version_id = table.Column<Guid>(type: "uuid", nullable: false),
                    object_key = table.Column<string>(type: "character varying(512)", maxLength: 512, nullable: false),
                    file_name = table.Column<string>(type: "character varying(255)", maxLength: 255, nullable: false),
                    media_type = table.Column<string>(type: "character varying(160)", maxLength: 160, nullable: false),
                    byte_length = table.Column<long>(type: "bigint", nullable: false),
                    sha256 = table.Column<string>(type: "character varying(64)", maxLength: 64, nullable: false),
                    previewable = table.Column<bool>(type: "boolean", nullable: false),
                    pixel_width = table.Column<int>(type: "integer", nullable: true),
                    pixel_height = table.Column<int>(type: "integer", nullable: true),
                    object_ready = table.Column<bool>(type: "boolean", nullable: false),
                    execution_id = table.Column<string>(type: "character varying(128)", maxLength: 128, nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_document_import_file_version", x => x.transfer_id);
                    table.UniqueConstraint("AK_document_import_file_version_tenant_id_transfer_id", x => new { x.tenant_id, x.transfer_id });
                    table.ForeignKey(
                        name: "FK_document_import_file_version_document_import_tenant_id_impo~",
                        columns: x => new { x.tenant_id, x.import_id },
                        principalTable: "document_import",
                        principalColumns: new[] { "tenant_id", "import_id" },
                        onDelete: ReferentialAction.Cascade);
                    table.ForeignKey(
                        name: "FK_document_import_file_version_file_version_tenant_id_target_~",
                        columns: x => new { x.tenant_id, x.target_item_id, x.file_version_id },
                        principalTable: "file_version",
                        principalColumns: new[] { "tenant_id", "item_id", "file_version_id" },
                        onDelete: ReferentialAction.Cascade);
                    table.ForeignKey(
                        name: "FK_document_import_file_version_item_tenant_id_target_item_id",
                        columns: x => new { x.tenant_id, x.target_item_id },
                        principalTable: "item",
                        principalColumns: new[] { "tenant_id", "id" },
                        onDelete: ReferentialAction.Cascade);
                });

            Nix.Persistence.Migrations.DocumentImportFileVersionSecuritySql.Apply(sql => migrationBuilder.Sql(sql));

            migrationBuilder.CreateIndex(
                name: "IX_document_import_file_version_tenant_id_file_version_id",
                table: "document_import_file_version",
                columns: new[] { "tenant_id", "file_version_id" },
                unique: true);

            migrationBuilder.CreateIndex(
                name: "IX_document_import_file_version_tenant_id_import_id_source_ite~",
                table: "document_import_file_version",
                columns: new[] { "tenant_id", "import_id", "source_item_id" });

            migrationBuilder.CreateIndex(
                name: "IX_document_import_file_version_tenant_id_target_item_id_file_~",
                table: "document_import_file_version",
                columns: new[] { "tenant_id", "target_item_id", "file_version_id" });
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            Nix.Persistence.Migrations.DocumentImportFileVersionSecuritySql.Revert(sql => migrationBuilder.Sql(sql));
            migrationBuilder.DropTable(
                name: "document_import_file_version");
        }
    }
}
