using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Migrations;

namespace Nix.Persistence.Migrations.Generated;

/// <summary>Adds capability-only CLI pairing state without changing the EF domain model.</summary>
[DbContext(typeof(NixDbContext))]
[Migration("20261009160000_CliBrowserLogin")]
public sealed class CliBrowserLogin : Migration
{
    /// <inheritdoc />
    protected override void Up(MigrationBuilder migrationBuilder) =>
        CliLoginSecuritySql.Apply(sql => migrationBuilder.Sql(sql));

    /// <inheritdoc />
    protected override void Down(MigrationBuilder migrationBuilder) =>
        CliLoginSecuritySql.Revert(sql => migrationBuilder.Sql(sql));
}
