using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Nix.Persistence.Migrations.Generated
{
    // [SEC] A lock covers its subtree (applied below via ItemLockSubtreeSecuritySql): the collaboration
    // service may read the closure to leave out bodies under a locked ancestor, the search index
    // feed withholds them, and placing or removing a lock re-indexes everything under it. No
    // schema change, so the model snapshot is untouched. Widens the collaboration role's grants:
    // requires security review and owner approval before merge.
    /// <inheritdoc />
    public partial class ItemLockSubtrees : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            ItemLockSubtreeSecuritySql.Apply(sql => migrationBuilder.Sql(sql));
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            ItemLockSubtreeSecuritySql.Revert(sql => migrationBuilder.Sql(sql));
        }
    }
}
