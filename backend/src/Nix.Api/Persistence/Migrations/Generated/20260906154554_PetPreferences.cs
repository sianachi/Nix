using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Nix.Persistence.Migrations.Generated
{
    /// <inheritdoc />
    public partial class PetPreferences : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.CreateTable(
                name: "pet_preferences",
                columns: table => new
                {
                    tenant_id = table.Column<Guid>(type: "uuid", nullable: false),
                    principal_id = table.Column<Guid>(type: "uuid", nullable: false),
                    settings = table.Column<string>(type: "jsonb", nullable: false),
                    revision = table.Column<long>(type: "bigint", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_pet_preferences", x => new { x.tenant_id, x.principal_id });
                    table.CheckConstraint("pet_preferences_bounded", "octet_length(settings::text) <= 65536 AND revision > 0");
                    table.ForeignKey(
                        name: "FK_pet_preferences_principal_tenant_id_principal_id",
                        columns: x => new { x.tenant_id, x.principal_id },
                        principalTable: "principal",
                        principalColumns: new[] { "tenant_id", "principal_id" },
                        onDelete: ReferentialAction.Cascade);
                });

            PetPreferencesSecuritySql.Apply(sql => migrationBuilder.Sql(sql));
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "pet_preferences");
        }
    }
}
