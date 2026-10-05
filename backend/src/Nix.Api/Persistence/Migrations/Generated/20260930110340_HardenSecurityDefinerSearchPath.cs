using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Nix.Persistence.Migrations.Generated
{
    // [SEC] Pins pg_temp last in the search path of every SECURITY DEFINER function in public
    // (applied below via SecurityDefinerSearchPathSecuritySql). Without it the caller's temporary
    // schema was searched first for relations, letting a caller with TEMPORARY shadow a table the
    // function names and run a trigger as the schema owner. No schema change, so the model
    // snapshot is untouched. Requires security review and owner approval before merge.
    /// <inheritdoc />
    public partial class HardenSecurityDefinerSearchPath : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            SecurityDefinerSearchPathSecuritySql.Apply(sql => migrationBuilder.Sql(sql));
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            // Intentionally empty: restoring the unsafe search paths is never wanted.
            SecurityDefinerSearchPathSecuritySql.Revert(sql => migrationBuilder.Sql(sql));
        }
    }
}
