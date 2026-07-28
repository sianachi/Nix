using System;
using Microsoft.EntityFrameworkCore.Migrations;
using Nix.Persistence.Migrations;
// ReSharper disable All

#nullable disable

namespace Nix.Persistence.Migrations.Generated
{
    /// <inheritdoc />
    public partial class ContentSchema : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.CreateTable(
                name: "content_doc",
                columns: table => new
                {
                    doc_id = table.Column<Guid>(type: "uuid", nullable: false),
                    tenant_id = table.Column<Guid>(type: "uuid", nullable: false),
                    item_id = table.Column<Guid>(type: "uuid", nullable: false),
                    workspace_id = table.Column<Guid>(type: "uuid", nullable: false),
                    schema_version = table.Column<int>(type: "integer", nullable: false),
                    head_seq = table.Column<long>(type: "bigint", nullable: false),
                    created_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_content_doc", x => x.doc_id);
                    table.UniqueConstraint("AK_content_doc_tenant_id_doc_id", x => new { x.tenant_id, x.doc_id });
                    table.ForeignKey(
                        name: "FK_content_doc_item_tenant_id_item_id",
                        columns: x => new { x.tenant_id, x.item_id },
                        principalTable: "item",
                        principalColumns: new[] { "tenant_id", "id" },
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateTable(
                name: "content_snapshot",
                columns: table => new
                {
                    doc_id = table.Column<Guid>(type: "uuid", nullable: false),
                    seq = table.Column<long>(type: "bigint", nullable: false),
                    tenant_id = table.Column<Guid>(type: "uuid", nullable: false),
                    yjs_state = table.Column<byte[]>(type: "bytea", nullable: false),
                    prosemirror_json = table.Column<string>(type: "jsonb", nullable: true),
                    plaintext = table.Column<string>(type: "text", nullable: true),
                    created_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_content_snapshot", x => new { x.doc_id, x.seq });
                    table.ForeignKey(
                        name: "FK_content_snapshot_content_doc_tenant_id_doc_id",
                        columns: x => new { x.tenant_id, x.doc_id },
                        principalTable: "content_doc",
                        principalColumns: new[] { "tenant_id", "doc_id" },
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateTable(
                name: "content_update",
                columns: table => new
                {
                    doc_id = table.Column<Guid>(type: "uuid", nullable: false),
                    seq = table.Column<long>(type: "bigint", nullable: false),
                    tenant_id = table.Column<Guid>(type: "uuid", nullable: false),
                    update_bytes = table.Column<byte[]>(type: "bytea", nullable: false),
                    actor_id = table.Column<Guid>(type: "uuid", nullable: false),
                    client_id = table.Column<string>(type: "text", nullable: false),
                    created_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_content_update", x => new { x.doc_id, x.seq });
                    table.ForeignKey(
                        name: "FK_content_update_content_doc_tenant_id_doc_id",
                        columns: x => new { x.tenant_id, x.doc_id },
                        principalTable: "content_doc",
                        principalColumns: new[] { "tenant_id", "doc_id" },
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateIndex(
                name: "IX_content_doc_tenant_id_item_id",
                table: "content_doc",
                columns: new[] { "tenant_id", "item_id" },
                unique: true);

            migrationBuilder.CreateIndex(
                name: "IX_content_snapshot_tenant_id_doc_id",
                table: "content_snapshot",
                columns: new[] { "tenant_id", "doc_id" });

            migrationBuilder.CreateIndex(
                name: "IX_content_update_tenant_id_doc_id",
                table: "content_update",
                columns: new[] { "tenant_id", "doc_id" });

            // Isolation policies, the read-only/read-write grant split between the API and the
            // collaboration service, and the payload bounds. Hand-authored and kept outside this
            // folder so a re-scaffold cannot delete it; if this call goes missing the content
            // tables are readable across tenants and the isolation tests fail.
            ContentSecuritySql.Apply(sql => migrationBuilder.Sql(sql));
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "content_snapshot");

            migrationBuilder.DropTable(
                name: "content_update");

            migrationBuilder.DropTable(
                name: "content_doc");
        }
    }
}
