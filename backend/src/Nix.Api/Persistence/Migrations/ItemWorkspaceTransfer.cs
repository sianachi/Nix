using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Migrations;

namespace Nix.Persistence.Migrations;

/// <summary>Adds metadata-only workspace transfer support; the EF model is unchanged.</summary>
[DbContext(typeof(NixDbContext))]
[Migration("20261005200000_ItemWorkspaceTransfer")]
public sealed class ItemWorkspaceTransfer : Migration
{
    protected override void Up(MigrationBuilder migrationBuilder) =>
        ItemWorkspaceTransferSecuritySql.Apply(sql => migrationBuilder.Sql(sql));

    protected override void Down(MigrationBuilder migrationBuilder) =>
        ItemWorkspaceTransferSecuritySql.Revert(sql => migrationBuilder.Sql(sql));
}
