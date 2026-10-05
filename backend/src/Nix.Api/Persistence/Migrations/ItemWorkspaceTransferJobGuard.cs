using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Migrations;

namespace Nix.Persistence.Migrations;

/// <summary>Bounds transfer job inspection and search events to the changed subtree and active jobs.</summary>
[DbContext(typeof(NixDbContext))]
[Migration("20261005210000_ItemWorkspaceTransferJobGuard")]
public sealed class ItemWorkspaceTransferJobGuard : Migration
{
    protected override void Up(MigrationBuilder migrationBuilder) =>
        ItemWorkspaceTransferJobGuardSql.Apply(sql => migrationBuilder.Sql(sql));

    protected override void Down(MigrationBuilder migrationBuilder) =>
        ItemWorkspaceTransferJobGuardSql.Revert(sql => migrationBuilder.Sql(sql));
}
