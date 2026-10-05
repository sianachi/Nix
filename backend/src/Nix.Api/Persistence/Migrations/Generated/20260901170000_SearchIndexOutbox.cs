using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Nix.Persistence.Migrations.Generated;

/// <inheritdoc />
[DbContext(typeof(NixDbContext))]
[Migration("20260901170000_SearchIndexOutbox")]
public sealed class SearchIndexOutbox : Migration
{
    /// <inheritdoc />
    protected override void Up(MigrationBuilder migrationBuilder) =>
        SearchIndexOutboxSecuritySql.Apply(sql => migrationBuilder.Sql(sql));

    /// <inheritdoc />
    protected override void Down(MigrationBuilder migrationBuilder) =>
        SearchIndexOutboxSecuritySql.Revert(sql => migrationBuilder.Sql(sql));
}
