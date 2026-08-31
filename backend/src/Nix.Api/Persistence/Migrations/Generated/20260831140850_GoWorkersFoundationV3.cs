using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Nix.Persistence.Migrations.Generated
{
    /// <inheritdoc />
    public partial class GoWorkersFoundationV3 : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.CreateTable(
                name: "worker_job",
                columns: table => new
                {
                    job_id = table.Column<Guid>(type: "uuid", nullable: false),
                    tenant_id = table.Column<Guid>(type: "uuid", nullable: false),
                    workspace_id = table.Column<Guid>(type: "uuid", nullable: true),
                    actor_id = table.Column<Guid>(type: "uuid", nullable: true),
                    kind = table.Column<string>(type: "character varying(64)", maxLength: 64, nullable: false),
                    idempotency_key = table.Column<string>(type: "character varying(160)", maxLength: 160, nullable: false),
                    payload = table.Column<string>(type: "jsonb", nullable: false),
                    status = table.Column<string>(type: "character varying(32)", maxLength: 32, nullable: false),
                    result = table.Column<string>(type: "jsonb", nullable: true),
                    error_code = table.Column<string>(type: "character varying(64)", maxLength: 64, nullable: true),
                    error_detail = table.Column<string>(type: "character varying(2000)", maxLength: 2000, nullable: true),
                    Attempts = table.Column<int>(type: "integer", nullable: false),
                    lease_owner = table.Column<string>(type: "character varying(128)", maxLength: 128, nullable: true),
                    LeaseUntil = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true),
                    CancellationRequested = table.Column<bool>(type: "boolean", nullable: false),
                    created_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    StartedAt = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true),
                    CompletedAt = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true),
                    updated_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_worker_job", x => x.job_id);
                    table.UniqueConstraint("AK_worker_job_tenant_id_job_id", x => new { x.tenant_id, x.job_id });
                    table.ForeignKey(
                        name: "FK_worker_job_workspace_tenant_id_workspace_id",
                        columns: x => new { x.tenant_id, x.workspace_id },
                        principalTable: "workspace",
                        principalColumns: new[] { "tenant_id", "workspace_id" },
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateTable(
                name: "worker_outbox_event",
                columns: table => new
                {
                    event_id = table.Column<Guid>(type: "uuid", nullable: false),
                    tenant_id = table.Column<Guid>(type: "uuid", nullable: false),
                    workspace_id = table.Column<Guid>(type: "uuid", nullable: true),
                    item_id = table.Column<Guid>(type: "uuid", nullable: true),
                    kind = table.Column<string>(type: "character varying(64)", maxLength: 64, nullable: false),
                    AggregateVersion = table.Column<long>(type: "bigint", nullable: true),
                    payload = table.Column<string>(type: "jsonb", nullable: false),
                    AvailableAt = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    Attempts = table.Column<int>(type: "integer", nullable: false),
                    lease_owner = table.Column<string>(type: "character varying(128)", maxLength: 128, nullable: true),
                    LeaseUntil = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true),
                    ProcessedAt = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true),
                    last_error = table.Column<string>(type: "character varying(2000)", maxLength: 2000, nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_worker_outbox_event", x => x.event_id);
                    table.UniqueConstraint("AK_worker_outbox_event_tenant_id_event_id", x => new { x.tenant_id, x.event_id });
                });

            migrationBuilder.CreateIndex(
                name: "IX_worker_job_status_LeaseUntil_created_at",
                table: "worker_job",
                columns: new[] { "status", "LeaseUntil", "created_at" });

            migrationBuilder.CreateIndex(
                name: "IX_worker_job_tenant_id_actor_id_idempotency_key",
                table: "worker_job",
                columns: new[] { "tenant_id", "actor_id", "idempotency_key" },
                unique: true);

            migrationBuilder.CreateIndex(
                name: "IX_worker_job_tenant_id_workspace_id",
                table: "worker_job",
                columns: new[] { "tenant_id", "workspace_id" });

            migrationBuilder.CreateIndex(
                name: "IX_worker_outbox_event_ProcessedAt_AvailableAt_LeaseUntil",
                table: "worker_outbox_event",
                columns: new[] { "ProcessedAt", "AvailableAt", "LeaseUntil" });

            migrationBuilder.CreateIndex(
                name: "IX_worker_outbox_event_tenant_id_item_id_AggregateVersion",
                table: "worker_outbox_event",
                columns: new[] { "tenant_id", "item_id", "AggregateVersion" });

            Nix.Persistence.Migrations.WorkerSecuritySql.Apply(sql => migrationBuilder.Sql(sql));
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            Nix.Persistence.Migrations.WorkerSecuritySql.Revert(sql => migrationBuilder.Sql(sql));

            migrationBuilder.DropTable(
                name: "worker_job");

            migrationBuilder.DropTable(
                name: "worker_outbox_event");
        }
    }
}
