using System;
using Microsoft.EntityFrameworkCore.Migrations;
using Nix.Persistence.Migrations;

#nullable disable

namespace Nix.Persistence.Migrations.Generated
{
    /// <inheritdoc />
    public partial class NotificationsHardening : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropIndex(
                name: "IX_push_subscription_tenant_id_principal_id",
                table: "push_subscription");

            migrationBuilder.DropCheckConstraint(
                name: "push_subscription_bounded",
                table: "push_subscription");

            migrationBuilder.DropIndex(
                name: "IX_notification_tenant_id_dedupe_key",
                table: "notification");

            migrationBuilder.CreateTable(
                name: "notification_inbox",
                columns: table => new
                {
                    tenant_id = table.Column<Guid>(type: "uuid", nullable: false),
                    principal_id = table.Column<Guid>(type: "uuid", nullable: false),
                    revision = table.Column<long>(type: "bigint", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_notification_inbox", x => new { x.tenant_id, x.principal_id });
                    table.CheckConstraint("notification_inbox_revision", "revision >= 0");
                    table.ForeignKey(
                        name: "FK_notification_inbox_principal_tenant_id_principal_id",
                        columns: x => new { x.tenant_id, x.principal_id },
                        principalTable: "principal",
                        principalColumns: new[] { "tenant_id", "principal_id" },
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.AddCheckConstraint(
                name: "push_subscription_bounded",
                table: "push_subscription",
                sql: "octet_length(endpoint) <= 2048 AND char_length(p256dh) <= 128 AND char_length(auth) <= 64 AND char_length(user_agent) <= 400 AND failures >= 0");

            migrationBuilder.AddCheckConstraint(
                name: "principal_preferences_quiet_hours",
                table: "principal_preferences",
                sql: "(quiet_start IS NULL) = (quiet_end IS NULL)");

            migrationBuilder.CreateIndex(
                name: "IX_notification_tenant_id_principal_id_dedupe_key",
                table: "notification",
                columns: new[] { "tenant_id", "principal_id", "dedupe_key" },
                unique: true);

            migrationBuilder.CreateIndex(
                name: "IX_notification_tenant_id_principal_id_seq_unread",
                table: "notification",
                columns: new[] { "tenant_id", "principal_id", "seq" },
                filter: "read_at IS NULL");

            NotificationsHardeningSecuritySql.Apply(sql => migrationBuilder.Sql(sql));
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "notification_inbox");

            migrationBuilder.DropCheckConstraint(
                name: "push_subscription_bounded",
                table: "push_subscription");

            migrationBuilder.DropCheckConstraint(
                name: "principal_preferences_quiet_hours",
                table: "principal_preferences");

            migrationBuilder.DropIndex(
                name: "IX_notification_tenant_id_principal_id_dedupe_key",
                table: "notification");

            migrationBuilder.DropIndex(
                name: "IX_notification_tenant_id_principal_id_seq_unread",
                table: "notification");

            migrationBuilder.CreateIndex(
                name: "IX_push_subscription_tenant_id_principal_id",
                table: "push_subscription",
                columns: new[] { "tenant_id", "principal_id" });

            migrationBuilder.AddCheckConstraint(
                name: "push_subscription_bounded",
                table: "push_subscription",
                sql: "char_length(endpoint) <= 2048 AND char_length(p256dh) <= 128 AND char_length(auth) <= 64 AND char_length(user_agent) <= 400 AND failures >= 0");

            migrationBuilder.CreateIndex(
                name: "IX_notification_tenant_id_dedupe_key",
                table: "notification",
                columns: new[] { "tenant_id", "dedupe_key" },
                unique: true);
        }
    }
}
