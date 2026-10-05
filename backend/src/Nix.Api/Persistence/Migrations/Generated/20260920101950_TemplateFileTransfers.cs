using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Nix.Persistence.Migrations.Generated
{
    /// <inheritdoc />
    public partial class TemplateFileTransfers : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.CreateTable(
                name: "template_file_transfer",
                columns: table => new
                {
                    transfer_id = table.Column<Guid>(type: "uuid", nullable: false),
                    tenant_id = table.Column<Guid>(type: "uuid", nullable: false),
                    workspace_id = table.Column<Guid>(type: "uuid", nullable: false),
                    operation_id = table.Column<Guid>(type: "uuid", nullable: true),
                    application_id = table.Column<Guid>(type: "uuid", nullable: true),
                    source_item_id = table.Column<Guid>(type: "uuid", nullable: false),
                    target_item_id = table.Column<Guid>(type: "uuid", nullable: false),
                    target_version_id = table.Column<Guid>(type: "uuid", nullable: false),
                    source_object_key = table.Column<string>(type: "character varying(512)", maxLength: 512, nullable: false),
                    file_name = table.Column<string>(type: "character varying(255)", maxLength: 255, nullable: false),
                    media_type = table.Column<string>(type: "character varying(160)", maxLength: 160, nullable: false),
                    byte_length = table.Column<long>(type: "bigint", nullable: false),
                    sha256 = table.Column<string>(type: "character varying(64)", maxLength: 64, nullable: false),
                    previewable = table.Column<bool>(type: "boolean", nullable: false),
                    pixel_width = table.Column<int>(type: "integer", nullable: true),
                    pixel_height = table.Column<int>(type: "integer", nullable: true),
                    execution_id = table.Column<string>(type: "character varying(128)", maxLength: 128, nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_template_file_transfer", x => x.transfer_id);
                    table.UniqueConstraint("AK_template_file_transfer_tenant_id_transfer_id", x => new { x.tenant_id, x.transfer_id });
                    table.CheckConstraint("CK_template_file_transfer_owner", "(operation_id IS NOT NULL AND application_id IS NULL) OR (operation_id IS NULL AND application_id IS NOT NULL)");
                    table.ForeignKey(
                        name: "FK_template_file_transfer_file_version_tenant_id_target_item_i~",
                        columns: x => new { x.tenant_id, x.target_item_id, x.target_version_id },
                        principalTable: "file_version",
                        principalColumns: new[] { "tenant_id", "item_id", "file_version_id" },
                        onDelete: ReferentialAction.Cascade);
                    table.ForeignKey(
                        name: "FK_template_file_transfer_template_application_tenant_id_appli~",
                        columns: x => new { x.tenant_id, x.application_id },
                        principalTable: "template_application",
                        principalColumns: new[] { "tenant_id", "application_id" },
                        onDelete: ReferentialAction.Cascade);
                    table.ForeignKey(
                        name: "FK_template_file_transfer_template_operation_tenant_id_operati~",
                        columns: x => new { x.tenant_id, x.operation_id },
                        principalTable: "template_operation",
                        principalColumns: new[] { "tenant_id", "operation_id" },
                        onDelete: ReferentialAction.Cascade);
                });

            Nix.Persistence.Migrations.TemplateFileTransferSecuritySql.Apply(sql => migrationBuilder.Sql(sql));

            migrationBuilder.CreateIndex(
                name: "IX_template_file_transfer_tenant_id_application_id",
                table: "template_file_transfer",
                columns: new[] { "tenant_id", "application_id" });

            migrationBuilder.CreateIndex(
                name: "IX_template_file_transfer_tenant_id_operation_id",
                table: "template_file_transfer",
                columns: new[] { "tenant_id", "operation_id" });

            migrationBuilder.CreateIndex(
                name: "IX_template_file_transfer_tenant_id_target_item_id_target_vers~",
                table: "template_file_transfer",
                columns: new[] { "tenant_id", "target_item_id", "target_version_id" });

            migrationBuilder.CreateIndex(
                name: "IX_template_file_transfer_tenant_id_target_version_id",
                table: "template_file_transfer",
                columns: new[] { "tenant_id", "target_version_id" },
                unique: true);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            Nix.Persistence.Migrations.TemplateFileTransferSecuritySql.Revert(sql => migrationBuilder.Sql(sql));
            migrationBuilder.DropTable(
                name: "template_file_transfer");
        }
    }
}
