using Microsoft.EntityFrameworkCore.Migrations;
using Nix.Persistence.Migrations;

#nullable disable

namespace Nix.Persistence.Migrations.Generated
{
    /// <inheritdoc />
    public partial class SchedulingLeaseCapAndRetentionIndexes : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropIndex(
                name: "IX_scheduled_trigger_tenant_id_principal_id_kind_status_fire_at",
                table: "scheduled_trigger");

            migrationBuilder.DropCheckConstraint(
                name: "scheduled_trigger_bounded",
                table: "scheduled_trigger");

            // Added nullable, backfilled, then tightened - rather than a blank-string default -
            // because every existing row today can only have come from SystemTestTriggerSource
            // (the only ITriggerSource this build registers so far), and an empty string would
            // fail the bounded check constraint added below (source ~ '^[a-z0-9._-]+$' requires
            // at least one character).
            migrationBuilder.AddColumn<string>(
                name: "source",
                table: "scheduled_trigger",
                type: "character varying(64)",
                maxLength: 64,
                nullable: true);

            migrationBuilder.Sql("UPDATE scheduled_trigger SET source = 'system.test' WHERE source IS NULL;");

            migrationBuilder.AlterColumn<string>(
                name: "source",
                table: "scheduled_trigger",
                type: "character varying(64)",
                maxLength: 64,
                nullable: false,
                oldClrType: typeof(string),
                oldType: "character varying(64)",
                oldMaxLength: 64,
                oldNullable: true);

            migrationBuilder.CreateIndex(
                name: "IX_scheduled_trigger_recipient_kind_source_status_fire_at",
                table: "scheduled_trigger",
                columns: new[] { "tenant_id", "principal_id", "kind", "source", "status", "fire_at" });

            migrationBuilder.CreateIndex(
                name: "IX_scheduled_trigger_updated_at_finished",
                table: "scheduled_trigger",
                column: "updated_at",
                filter: "status IN ('fired', 'skipped', 'cancelled')");

            migrationBuilder.AddCheckConstraint(
                name: "scheduled_trigger_bounded",
                table: "scheduled_trigger",
                sql: "kind IN ('reminder', 'automation', 'system') AND status IN ('pending', 'leased', 'fired', 'skipped', 'cancelled') AND attempts >= 0 AND char_length(dedupe_key) <= 200 AND (lease_owner IS NULL OR char_length(lease_owner) <= 128) AND char_length(source) <= 64 AND source ~ '^[a-z0-9._-]+$'");

            migrationBuilder.CreateIndex(
                name: "IX_notification_created_at",
                table: "notification",
                column: "created_at");

            SchedulingLeaseAttemptCapSecuritySql.Apply(sql => migrationBuilder.Sql(sql));
            ReminderSourceSecuritySql.Apply(sql => migrationBuilder.Sql(sql));
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            ReminderSourceSecuritySql.Revert(sql => migrationBuilder.Sql(sql));
            SchedulingLeaseAttemptCapSecuritySql.Revert(sql => migrationBuilder.Sql(sql));

            migrationBuilder.DropIndex(
                name: "IX_scheduled_trigger_recipient_kind_source_status_fire_at",
                table: "scheduled_trigger");

            migrationBuilder.DropIndex(
                name: "IX_scheduled_trigger_updated_at_finished",
                table: "scheduled_trigger");

            migrationBuilder.DropCheckConstraint(
                name: "scheduled_trigger_bounded",
                table: "scheduled_trigger");

            migrationBuilder.DropIndex(
                name: "IX_notification_created_at",
                table: "notification");

            migrationBuilder.DropColumn(
                name: "source",
                table: "scheduled_trigger");

            migrationBuilder.CreateIndex(
                name: "IX_scheduled_trigger_tenant_id_principal_id_kind_status_fire_at",
                table: "scheduled_trigger",
                columns: new[] { "tenant_id", "principal_id", "kind", "status", "fire_at" });

            migrationBuilder.AddCheckConstraint(
                name: "scheduled_trigger_bounded",
                table: "scheduled_trigger",
                sql: "kind IN ('reminder', 'automation', 'system') AND status IN ('pending', 'leased', 'fired', 'skipped', 'cancelled') AND attempts >= 0 AND char_length(dedupe_key) <= 200 AND (lease_owner IS NULL OR char_length(lease_owner) <= 128)");
        }
    }
}
