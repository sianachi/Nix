using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Nix.Persistence.Migrations.Generated;

/// <inheritdoc />
[DbContext(typeof(NixDbContext))]
[Migration("20260831201500_RabbitWorkerDispatch")]
public sealed class RabbitWorkerDispatch : Migration
{
    /// <inheritdoc />
    protected override void Up(MigrationBuilder migrationBuilder) =>
        RabbitWorkerSecuritySql.Apply(sql => migrationBuilder.Sql(sql));

    /// <inheritdoc />
    protected override void Down(MigrationBuilder migrationBuilder)
    {
        RabbitWorkerSecuritySql.Revert(sql => migrationBuilder.Sql(sql));
        WorkerRetrySecuritySql.Apply(sql => migrationBuilder.Sql(sql));
    }
}
