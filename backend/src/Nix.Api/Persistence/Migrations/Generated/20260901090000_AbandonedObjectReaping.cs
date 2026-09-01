using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Nix.Persistence.Migrations.Generated;

/// <inheritdoc />
[DbContext(typeof(NixDbContext))]
[Migration("20260901090000_AbandonedObjectReaping")]
public sealed class AbandonedObjectReaping : Migration
{
    /// <inheritdoc />
    protected override void Up(MigrationBuilder migrationBuilder)
    {
        AbandonedObjectReapingSecuritySql.Apply(sql => migrationBuilder.Sql(sql));
        WorkerExecutionSecuritySql.ApplyAllowingSystemCleanup(sql => migrationBuilder.Sql(sql));
    }

    /// <inheritdoc />
    protected override void Down(MigrationBuilder migrationBuilder)
    {
        WorkerExecutionSecuritySql.Apply(sql => migrationBuilder.Sql(sql));
        AbandonedObjectReapingSecuritySql.Revert(sql => migrationBuilder.Sql(sql));
    }
}
