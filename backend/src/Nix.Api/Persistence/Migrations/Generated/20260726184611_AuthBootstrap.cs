using Microsoft.EntityFrameworkCore.Migrations;
using Nix.Persistence.Migrations;
// ReSharper disable All

#nullable disable

namespace Nix.Persistence.Migrations.Generated
{
    /// <inheritdoc />
    public partial class AuthBootstrap : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            // No schema change: this migration exists only to add the second pre-authentication
            // lookup. See AuthBootstrapSecuritySql for why it has to be a security-definer
            // function rather than a plain query.
            AuthBootstrapSecuritySql.Apply(sql => migrationBuilder.Sql(sql));
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            AuthBootstrapSecuritySql.Revert(sql => migrationBuilder.Sql(sql));
        }
    }
}
