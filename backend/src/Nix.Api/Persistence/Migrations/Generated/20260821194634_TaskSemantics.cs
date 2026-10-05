using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Nix.Persistence.Migrations.Generated
{
    /// <inheritdoc />
    public partial class TaskSemantics : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<string>(
                name: "recurrence",
                table: "item",
                type: "jsonb",
                nullable: true);

            migrationBuilder.AddColumn<string>(
                name: "due_day",
                table: "item",
                type: "text",
                nullable: true,
                computedColumnSql: "left(properties ->> 'due_date', 10)",
                stored: true);

            Nix.Persistence.Migrations.TaskSemanticsSecuritySql.Apply(sql => migrationBuilder.Sql(sql));
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            Nix.Persistence.Migrations.TaskSemanticsSecuritySql.Revert(sql => migrationBuilder.Sql(sql));

            migrationBuilder.DropColumn(
                name: "due_day",
                table: "item");

            migrationBuilder.DropColumn(
                name: "recurrence",
                table: "item");
        }
    }
}
