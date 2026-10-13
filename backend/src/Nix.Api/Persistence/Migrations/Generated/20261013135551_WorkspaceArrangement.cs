using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Nix.Persistence.Migrations.Generated
{
    /// <inheritdoc />
    public partial class WorkspaceArrangement : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.CreateTable(
                name: "workspace_arrangement",
                columns: table => new
                {
                    tenant_id = table.Column<Guid>(type: "uuid", nullable: false),
                    principal_id = table.Column<Guid>(type: "uuid", nullable: false),
                    groups_json = table.Column<string>(type: "jsonb", nullable: false),
                    pinned_workspace_ids = table.Column<Guid[]>(type: "uuid[]", nullable: false),
                    revision = table.Column<long>(type: "bigint", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_workspace_arrangement", x => new { x.tenant_id, x.principal_id });
                    table.CheckConstraint("workspace_arrangement_bounded", "(array_length(pinned_workspace_ids, 1) IS NULL OR array_length(pinned_workspace_ids, 1) <= 200) AND octet_length(groups_json::text) <= 65536");
                    table.ForeignKey(
                        name: "FK_workspace_arrangement_principal_tenant_id_principal_id",
                        columns: x => new { x.tenant_id, x.principal_id },
                        principalTable: "principal",
                        principalColumns: new[] { "tenant_id", "principal_id" },
                        onDelete: ReferentialAction.Cascade);
                });

            WorkspaceArrangementSecuritySql.Apply(sql => migrationBuilder.Sql(sql));
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "workspace_arrangement");
        }
    }
}
