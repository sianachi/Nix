using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Migrations;

namespace Nix.Persistence.Migrations.Generated;

/// <summary>Adds <c>site_operator</c>: principals an administrator allowed to approve first publishes.</summary>
[DbContext(typeof(NixDbContext))]
[Migration("20261016150000_SiteOperatorGrants")]
public sealed class SiteOperatorGrants : Migration
{
    /// <inheritdoc />
    protected override void Up(MigrationBuilder migrationBuilder)
    {
        migrationBuilder.CreateTable(
            name: "site_operator",
            columns: table => new
            {
                tenant_id = table.Column<Guid>(type: "uuid", nullable: false),
                principal_id = table.Column<Guid>(type: "uuid", nullable: false),
                granted_by = table.Column<Guid>(type: "uuid", nullable: false),
                granted_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
            },
            constraints: table =>
            {
                table.PrimaryKey("pk_site_operator", x => new { x.tenant_id, x.principal_id });
                table.ForeignKey(
                    name: "fk_site_operator_principal",
                    columns: x => new { x.tenant_id, x.principal_id },
                    principalTable: "principal",
                    principalColumns: new[] { "tenant_id", "principal_id" },
                    onDelete: ReferentialAction.Cascade);
            });

        SiteOperatorSecuritySql.Apply(sql => migrationBuilder.Sql(sql));
    }

    /// <inheritdoc />
    protected override void Down(MigrationBuilder migrationBuilder) => migrationBuilder.DropTable(name: "site_operator");
}
