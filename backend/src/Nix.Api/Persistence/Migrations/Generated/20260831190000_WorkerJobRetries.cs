using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Nix.Persistence.Migrations.Generated;

/// <inheritdoc />
[DbContext(typeof(NixDbContext))]
[Migration("20260831190000_WorkerJobRetries")]
public sealed class WorkerJobRetries : Migration
{
    /// <inheritdoc />
    protected override void Up(MigrationBuilder migrationBuilder) =>
        WorkerRetrySecuritySql.Apply(sql => migrationBuilder.Sql(sql));

    /// <inheritdoc />
    protected override void Down(MigrationBuilder migrationBuilder) =>
        WorkerRetrySecuritySql.Revert(sql => migrationBuilder.Sql(sql));
}
