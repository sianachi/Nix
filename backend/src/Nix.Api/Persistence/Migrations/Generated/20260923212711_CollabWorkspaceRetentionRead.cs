using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Nix.Persistence.Migrations.Generated
{
    // [SEC] The collaboration service's retention sweep reads each workspace's retention window
    // (applied below via CollabWorkspaceRetentionReadSecuritySql). ContentVersions shipped the
    // sweep without the grant, so it only worked where the grant had been made by hand. No schema
    // change, so the model snapshot is untouched. Widens the collaboration role's grants: requires
    // security review and owner approval before merge.
    /// <inheritdoc />
    public partial class CollabWorkspaceRetentionRead : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            CollabWorkspaceRetentionReadSecuritySql.Apply(sql => migrationBuilder.Sql(sql));
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            CollabWorkspaceRetentionReadSecuritySql.Revert(sql => migrationBuilder.Sql(sql));
        }
    }
}
