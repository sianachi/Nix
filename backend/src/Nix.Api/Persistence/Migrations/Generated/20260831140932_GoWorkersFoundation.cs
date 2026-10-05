using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Nix.Persistence.Migrations.Generated
{
    /// <inheritdoc />
    public partial class GoWorkersFoundation : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.RenameColumn(
                name: "Attempts",
                table: "worker_outbox_event",
                newName: "attempts");

            migrationBuilder.RenameColumn(
                name: "ProcessedAt",
                table: "worker_outbox_event",
                newName: "processed_at");

            migrationBuilder.RenameColumn(
                name: "LeaseUntil",
                table: "worker_outbox_event",
                newName: "lease_until");

            migrationBuilder.RenameColumn(
                name: "AvailableAt",
                table: "worker_outbox_event",
                newName: "available_at");

            migrationBuilder.RenameColumn(
                name: "AggregateVersion",
                table: "worker_outbox_event",
                newName: "aggregate_version");

            migrationBuilder.RenameIndex(
                name: "IX_worker_outbox_event_tenant_id_item_id_AggregateVersion",
                table: "worker_outbox_event",
                newName: "IX_worker_outbox_event_tenant_id_item_id_aggregate_version");

            migrationBuilder.RenameIndex(
                name: "IX_worker_outbox_event_ProcessedAt_AvailableAt_LeaseUntil",
                table: "worker_outbox_event",
                newName: "IX_worker_outbox_event_processed_at_available_at_lease_until");

            migrationBuilder.RenameColumn(
                name: "Attempts",
                table: "worker_job",
                newName: "attempts");

            migrationBuilder.RenameColumn(
                name: "StartedAt",
                table: "worker_job",
                newName: "started_at");

            migrationBuilder.RenameColumn(
                name: "LeaseUntil",
                table: "worker_job",
                newName: "lease_until");

            migrationBuilder.RenameColumn(
                name: "CompletedAt",
                table: "worker_job",
                newName: "completed_at");

            migrationBuilder.RenameColumn(
                name: "CancellationRequested",
                table: "worker_job",
                newName: "cancellation_requested");

            migrationBuilder.RenameIndex(
                name: "IX_worker_job_status_LeaseUntil_created_at",
                table: "worker_job",
                newName: "IX_worker_job_status_lease_until_created_at");
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.RenameColumn(
                name: "attempts",
                table: "worker_outbox_event",
                newName: "Attempts");

            migrationBuilder.RenameColumn(
                name: "processed_at",
                table: "worker_outbox_event",
                newName: "ProcessedAt");

            migrationBuilder.RenameColumn(
                name: "lease_until",
                table: "worker_outbox_event",
                newName: "LeaseUntil");

            migrationBuilder.RenameColumn(
                name: "available_at",
                table: "worker_outbox_event",
                newName: "AvailableAt");

            migrationBuilder.RenameColumn(
                name: "aggregate_version",
                table: "worker_outbox_event",
                newName: "AggregateVersion");

            migrationBuilder.RenameIndex(
                name: "IX_worker_outbox_event_tenant_id_item_id_aggregate_version",
                table: "worker_outbox_event",
                newName: "IX_worker_outbox_event_tenant_id_item_id_AggregateVersion");

            migrationBuilder.RenameIndex(
                name: "IX_worker_outbox_event_processed_at_available_at_lease_until",
                table: "worker_outbox_event",
                newName: "IX_worker_outbox_event_ProcessedAt_AvailableAt_LeaseUntil");

            migrationBuilder.RenameColumn(
                name: "attempts",
                table: "worker_job",
                newName: "Attempts");

            migrationBuilder.RenameColumn(
                name: "started_at",
                table: "worker_job",
                newName: "StartedAt");

            migrationBuilder.RenameColumn(
                name: "lease_until",
                table: "worker_job",
                newName: "LeaseUntil");

            migrationBuilder.RenameColumn(
                name: "completed_at",
                table: "worker_job",
                newName: "CompletedAt");

            migrationBuilder.RenameColumn(
                name: "cancellation_requested",
                table: "worker_job",
                newName: "CancellationRequested");

            migrationBuilder.RenameIndex(
                name: "IX_worker_job_status_lease_until_created_at",
                table: "worker_job",
                newName: "IX_worker_job_status_LeaseUntil_created_at");
        }
    }
}
