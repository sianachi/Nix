using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Nix.Persistence.Migrations.Generated
{
    /// <inheritdoc />
    public partial class PublicForms : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.CreateTable(
                name: "public_form_link",
                columns: table => new
                {
                    id = table.Column<Guid>(type: "uuid", nullable: false),
                    tenant_id = table.Column<Guid>(type: "uuid", nullable: false),
                    workspace_id = table.Column<Guid>(type: "uuid", nullable: false),
                    item_id = table.Column<Guid>(type: "uuid", nullable: false),
                    view_id = table.Column<string>(type: "character varying(128)", maxLength: 128, nullable: false),
                    nonce = table.Column<string>(type: "character varying(64)", maxLength: 64, nullable: false),
                    submission_principal_id = table.Column<Guid>(type: "uuid", nullable: false),
                    published_by = table.Column<Guid>(type: "uuid", nullable: false),
                    published_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    revoked_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_public_form_link", x => x.id);
                    table.ForeignKey(
                        name: "FK_public_form_link_item_tenant_id_item_id",
                        columns: x => new { x.tenant_id, x.item_id },
                        principalTable: "item",
                        principalColumns: new[] { "tenant_id", "id" },
                        onDelete: ReferentialAction.Cascade);
                    table.ForeignKey(
                        name: "FK_public_form_link_principal_tenant_id_published_by",
                        columns: x => new { x.tenant_id, x.published_by },
                        principalTable: "principal",
                        principalColumns: new[] { "tenant_id", "principal_id" },
                        onDelete: ReferentialAction.Restrict);
                    table.ForeignKey(
                        name: "FK_public_form_link_principal_tenant_id_submission_principal_id",
                        columns: x => new { x.tenant_id, x.submission_principal_id },
                        principalTable: "principal",
                        principalColumns: new[] { "tenant_id", "principal_id" },
                        onDelete: ReferentialAction.Restrict);
                    table.ForeignKey(
                        name: "FK_public_form_link_tenant_tenant_id",
                        column: x => x.tenant_id,
                        principalTable: "tenant",
                        principalColumn: "tenant_id",
                        onDelete: ReferentialAction.Restrict);
                    table.ForeignKey(
                        name: "FK_public_form_link_workspace_tenant_id_workspace_id",
                        columns: x => new { x.tenant_id, x.workspace_id },
                        principalTable: "workspace",
                        principalColumns: new[] { "tenant_id", "workspace_id" },
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateIndex(
                name: "IX_public_form_link_tenant_id_item_id_view_id",
                table: "public_form_link",
                columns: new[] { "tenant_id", "item_id", "view_id" },
                unique: true);

            migrationBuilder.CreateIndex(
                name: "IX_public_form_link_tenant_id_published_by",
                table: "public_form_link",
                columns: new[] { "tenant_id", "published_by" });

            migrationBuilder.CreateIndex(
                name: "IX_public_form_link_tenant_id_submission_principal_id",
                table: "public_form_link",
                columns: new[] { "tenant_id", "submission_principal_id" });

            migrationBuilder.CreateIndex(
                name: "IX_public_form_link_tenant_id_workspace_id",
                table: "public_form_link",
                columns: new[] { "tenant_id", "workspace_id" });

            PublicFormSecuritySql.Apply(sql => migrationBuilder.Sql(sql));
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "public_form_link");
        }
    }
}
