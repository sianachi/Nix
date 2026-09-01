using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Nix.Persistence.Migrations.Generated;

/// <inheritdoc />
[DbContext(typeof(NixDbContext))]
[Migration("20260901143000_WorkerResultHardening")]
public sealed class WorkerResultHardening : Migration
{
    /// <inheritdoc />
    protected override void Up(MigrationBuilder migrationBuilder) =>
        WorkerResultHardeningSecuritySql.Apply(sql => migrationBuilder.Sql(sql));

    /// <inheritdoc />
    protected override void Down(MigrationBuilder migrationBuilder) =>
        WorkerResultHardeningSecuritySql.Revert(sql => migrationBuilder.Sql(sql));
}
