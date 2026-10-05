using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Nix.Persistence.Migrations.Generated;

/// <inheritdoc />
[DbContext(typeof(NixDbContext))]
[Migration("20260831210000_WorkerExecutionAuthorization")]
public sealed class WorkerExecutionAuthorization : Migration
{
    /// <inheritdoc />
    protected override void Up(MigrationBuilder migrationBuilder) =>
        WorkerExecutionSecuritySql.Apply(sql => migrationBuilder.Sql(sql));

    /// <inheritdoc />
    protected override void Down(MigrationBuilder migrationBuilder) =>
        WorkerExecutionSecuritySql.Revert(sql => migrationBuilder.Sql(sql));
}
