using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Nix.Persistence.Migrations.Generated
{
    /// <inheritdoc />
    public partial class WorkspaceLifecycle : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropForeignKey(
                name: "FK_item_workspace_tenant_id_workspace_id",
                table: "item");

            migrationBuilder.DropForeignKey(
                name: "FK_worker_job_workspace_tenant_id_workspace_id",
                table: "worker_job");

            migrationBuilder.DropForeignKey(
                name: "FK_workspace_invitation_workspace_tenant_id_workspace_id",
                table: "workspace_invitation");

            migrationBuilder.AddColumn<DateTimeOffset>(
                name: "archived_at",
                table: "workspace",
                type: "timestamp with time zone",
                nullable: true);

            migrationBuilder.AddColumn<string>(
                name: "lifecycle_state",
                table: "workspace",
                type: "text",
                nullable: false,
                defaultValue: "active");

            migrationBuilder.AddCheckConstraint(
                name: "CK_workspace_lifecycle_state",
                table: "workspace",
                sql: "lifecycle_state IN ('active', 'archived', 'purging')");

            migrationBuilder.AddForeignKey(
                name: "FK_item_workspace_tenant_id_workspace_id",
                table: "item",
                columns: new[] { "tenant_id", "workspace_id" },
                principalTable: "workspace",
                principalColumns: new[] { "tenant_id", "workspace_id" },
                onDelete: ReferentialAction.Cascade);

            migrationBuilder.Sql(
                "ALTER TABLE worker_job ADD CONSTRAINT \"FK_worker_job_workspace_tenant_id_workspace_id\" "
                + "FOREIGN KEY (tenant_id, workspace_id) REFERENCES workspace (tenant_id, workspace_id) "
                + "ON DELETE SET NULL (workspace_id);");

            migrationBuilder.AddForeignKey(
                name: "FK_workspace_invitation_workspace_tenant_id_workspace_id",
                table: "workspace_invitation",
                columns: new[] { "tenant_id", "workspace_id" },
                principalTable: "workspace",
                principalColumns: new[] { "tenant_id", "workspace_id" },
                onDelete: ReferentialAction.Cascade);

            WorkerExecutionFenceSecuritySql.Apply(sql => migrationBuilder.Sql(sql));
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            WorkerExecutionFenceSecuritySql.Apply(sql => migrationBuilder.Sql(sql));
            migrationBuilder.DropForeignKey(
                name: "FK_item_workspace_tenant_id_workspace_id",
                table: "item");

            migrationBuilder.DropForeignKey(
                name: "FK_worker_job_workspace_tenant_id_workspace_id",
                table: "worker_job");

            migrationBuilder.DropForeignKey(
                name: "FK_workspace_invitation_workspace_tenant_id_workspace_id",
                table: "workspace_invitation");

            migrationBuilder.DropCheckConstraint(
                name: "CK_workspace_lifecycle_state",
                table: "workspace");

            migrationBuilder.DropColumn(
                name: "archived_at",
                table: "workspace");

            migrationBuilder.DropColumn(
                name: "lifecycle_state",
                table: "workspace");

            migrationBuilder.AddForeignKey(
                name: "FK_item_workspace_tenant_id_workspace_id",
                table: "item",
                columns: new[] { "tenant_id", "workspace_id" },
                principalTable: "workspace",
                principalColumns: new[] { "tenant_id", "workspace_id" },
                onDelete: ReferentialAction.Restrict);

            migrationBuilder.AddForeignKey(
                name: "FK_worker_job_workspace_tenant_id_workspace_id",
                table: "worker_job",
                columns: new[] { "tenant_id", "workspace_id" },
                principalTable: "workspace",
                principalColumns: new[] { "tenant_id", "workspace_id" },
                onDelete: ReferentialAction.Cascade);

            migrationBuilder.AddForeignKey(
                name: "FK_workspace_invitation_workspace_tenant_id_workspace_id",
                table: "workspace_invitation",
                columns: new[] { "tenant_id", "workspace_id" },
                principalTable: "workspace",
                principalColumns: new[] { "tenant_id", "workspace_id" },
                onDelete: ReferentialAction.Restrict);
        }
    }
}
