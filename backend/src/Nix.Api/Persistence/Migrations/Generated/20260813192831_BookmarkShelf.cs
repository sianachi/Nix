using System;
using Microsoft.EntityFrameworkCore.Migrations;
using Npgsql.EntityFrameworkCore.PostgreSQL.Metadata;

#nullable disable

namespace Nix.Persistence.Migrations.Generated
{
    /// <inheritdoc />
    public partial class BookmarkShelf : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.CreateTable(
                name: "bookmark",
                columns: table => new
                {
                    principal_id = table.Column<Guid>(type: "uuid", nullable: false),
                    item_id = table.Column<Guid>(type: "uuid", nullable: false),
                    tenant_id = table.Column<Guid>(type: "uuid", nullable: false),
                    seq = table.Column<long>(type: "bigint", nullable: false)
                        .Annotation("Npgsql:ValueGenerationStrategy", NpgsqlValueGenerationStrategy.IdentityByDefaultColumn),
                    created_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_bookmark", x => new { x.principal_id, x.item_id });
                    table.ForeignKey(
                        name: "FK_bookmark_item_item_id",
                        column: x => x.item_id,
                        principalTable: "item",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Cascade);
                    table.ForeignKey(
                        name: "FK_bookmark_principal_tenant_id_principal_id",
                        columns: x => new { x.tenant_id, x.principal_id },
                        principalTable: "principal",
                        principalColumns: new[] { "tenant_id", "principal_id" },
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateIndex(
                name: "IX_bookmark_item_id",
                table: "bookmark",
                column: "item_id");

            migrationBuilder.CreateIndex(
                name: "IX_bookmark_tenant_id_principal_id_seq",
                table: "bookmark",
                columns: new[] { "tenant_id", "principal_id", "seq" });

            // The isolation policy, the runtime role's grants, and the bound on how many items one
            // person may keep. Hand-authored and kept outside this folder so a re-scaffold cannot
            // delete it; if this call goes missing, a table holding what everybody has kept arrives
            // unisolated, ungranted and unbounded.
            BookmarkSecuritySql.Apply(sql => migrationBuilder.Sql(sql));
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.Sql("DROP TRIGGER IF EXISTS bookmark_shelf_bounded ON bookmark;");
            migrationBuilder.Sql("DROP FUNCTION IF EXISTS nix_bound_bookmark_shelf();");

            migrationBuilder.DropTable(
                name: "bookmark");
        }
    }
}
