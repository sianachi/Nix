using System;
using Microsoft.EntityFrameworkCore.Migrations;
// ReSharper disable All

#nullable disable

namespace Nix.Persistence.Migrations.Generated
{
    /// <inheritdoc />
    public partial class LinksAndSearch : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.CreateTable(
                name: "item_link",
                columns: table => new
                {
                    tenant_id = table.Column<Guid>(type: "uuid", nullable: false),
                    source_item_id = table.Column<Guid>(type: "uuid", nullable: false),
                    target_item_id = table.Column<Guid>(type: "uuid", nullable: false),
                    occurrences = table.Column<int>(type: "integer", nullable: false),
                    seq = table.Column<long>(type: "bigint", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_item_link", x => new { x.tenant_id, x.source_item_id, x.target_item_id });
                    table.ForeignKey(
                        name: "FK_item_link_item_tenant_id_source_item_id",
                        columns: x => new { x.tenant_id, x.source_item_id },
                        principalTable: "item",
                        principalColumns: new[] { "tenant_id", "id" },
                        onDelete: ReferentialAction.Cascade);
                    table.ForeignKey(
                        name: "FK_item_link_item_tenant_id_target_item_id",
                        columns: x => new { x.tenant_id, x.target_item_id },
                        principalTable: "item",
                        principalColumns: new[] { "tenant_id", "id" },
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateTable(
                name: "item_search",
                columns: table => new
                {
                    tenant_id = table.Column<Guid>(type: "uuid", nullable: false),
                    item_id = table.Column<Guid>(type: "uuid", nullable: false),
                    seq = table.Column<long>(type: "bigint", nullable: false),
                    updated_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_item_search", x => new { x.tenant_id, x.item_id });
                    table.ForeignKey(
                        name: "FK_item_search_item_tenant_id_item_id",
                        columns: x => new { x.tenant_id, x.item_id },
                        principalTable: "item",
                        principalColumns: new[] { "tenant_id", "id" },
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateIndex(
                name: "ix_item_link_target",
                table: "item_link",
                columns: new[] { "tenant_id", "target_item_id" });

            // The isolation policies and the grant split for both tables, the tsvector column and
            // its GIN index, the REFERENCES grant the collaboration service needs to satisfy the
            // foreign keys above, and the trigram index over titles. Hand-authored and kept outside
            // this folder so a re-scaffold cannot delete it; if this call goes missing, two tables
            // holding customer text arrive unisolated and writable by the service that only reads
            // them, and neither search path has an index.
            LinksSecuritySql.Apply(sql => migrationBuilder.Sql(sql));
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "item_link");

            migrationBuilder.DropTable(
                name: "item_search");
        }
    }
}
