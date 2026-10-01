using System;
using Microsoft.EntityFrameworkCore.Migrations;
using Npgsql.EntityFrameworkCore.PostgreSQL.Metadata;

#nullable disable

namespace Nix.Persistence.Migrations.Generated
{
    /// <inheritdoc />
    public partial class AddNotifications : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.CreateTable(
                name: "notification",
                columns: table => new
                {
                    id = table.Column<Guid>(type: "uuid", nullable: false),
                    tenant_id = table.Column<Guid>(type: "uuid", nullable: false),
                    principal_id = table.Column<Guid>(type: "uuid", nullable: false),
                    kind = table.Column<string>(type: "character varying(16)", maxLength: 16, nullable: false),
                    title = table.Column<string>(type: "text", nullable: false),
                    body = table.Column<string>(type: "text", nullable: false),
                    item_id = table.Column<Guid>(type: "uuid", nullable: true),
                    workspace_id = table.Column<Guid>(type: "uuid", nullable: true),
                    created_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    seq = table.Column<long>(type: "bigint", nullable: false)
                        .Annotation("Npgsql:ValueGenerationStrategy", NpgsqlValueGenerationStrategy.IdentityByDefaultColumn),
                    read_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true),
                    dedupe_key = table.Column<string>(type: "character varying(200)", maxLength: 200, nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_notification", x => x.id);
                    table.CheckConstraint("notification_bounded", "char_length(title) <= 200 AND char_length(body) <= 1000 AND kind IN ('reminder', 'automation', 'calendar', 'system')");
                    table.ForeignKey(
                        name: "FK_notification_principal_tenant_id_principal_id",
                        columns: x => new { x.tenant_id, x.principal_id },
                        principalTable: "principal",
                        principalColumns: new[] { "tenant_id", "principal_id" },
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateTable(
                name: "principal_preferences",
                columns: table => new
                {
                    tenant_id = table.Column<Guid>(type: "uuid", nullable: false),
                    principal_id = table.Column<Guid>(type: "uuid", nullable: false),
                    time_zone = table.Column<string>(type: "character varying(64)", maxLength: 64, nullable: false),
                    quiet_start = table.Column<TimeOnly>(type: "time without time zone", nullable: true),
                    quiet_end = table.Column<TimeOnly>(type: "time without time zone", nullable: true),
                    due_reminder_time = table.Column<TimeOnly>(type: "time without time zone", nullable: false),
                    due_reminders = table.Column<bool>(type: "boolean", nullable: false),
                    habit_reminders = table.Column<bool>(type: "boolean", nullable: false),
                    muted_container_ids = table.Column<Guid[]>(type: "uuid[]", nullable: false),
                    revision = table.Column<long>(type: "bigint", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_principal_preferences", x => new { x.tenant_id, x.principal_id });
                    table.CheckConstraint("principal_preferences_bounded", "array_length(muted_container_ids, 1) IS NULL OR array_length(muted_container_ids, 1) <= 200");
                    table.ForeignKey(
                        name: "FK_principal_preferences_principal_tenant_id_principal_id",
                        columns: x => new { x.tenant_id, x.principal_id },
                        principalTable: "principal",
                        principalColumns: new[] { "tenant_id", "principal_id" },
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateTable(
                name: "push_subscription",
                columns: table => new
                {
                    id = table.Column<Guid>(type: "uuid", nullable: false),
                    tenant_id = table.Column<Guid>(type: "uuid", nullable: false),
                    principal_id = table.Column<Guid>(type: "uuid", nullable: false),
                    endpoint = table.Column<string>(type: "text", nullable: false),
                    p256dh = table.Column<string>(type: "text", nullable: false),
                    auth = table.Column<string>(type: "text", nullable: false),
                    user_agent = table.Column<string>(type: "text", nullable: false),
                    created_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    last_success_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true),
                    failures = table.Column<int>(type: "integer", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_push_subscription", x => x.id);
                    table.CheckConstraint("push_subscription_bounded", "char_length(endpoint) <= 2048 AND char_length(p256dh) <= 128 AND char_length(auth) <= 64 AND char_length(user_agent) <= 400 AND failures >= 0");
                    table.ForeignKey(
                        name: "FK_push_subscription_principal_tenant_id_principal_id",
                        columns: x => new { x.tenant_id, x.principal_id },
                        principalTable: "principal",
                        principalColumns: new[] { "tenant_id", "principal_id" },
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateIndex(
                name: "IX_notification_tenant_id_dedupe_key",
                table: "notification",
                columns: new[] { "tenant_id", "dedupe_key" },
                unique: true);

            migrationBuilder.CreateIndex(
                name: "IX_notification_tenant_id_principal_id_seq",
                table: "notification",
                columns: new[] { "tenant_id", "principal_id", "seq" });

            migrationBuilder.CreateIndex(
                name: "IX_push_subscription_tenant_id_principal_id",
                table: "push_subscription",
                columns: new[] { "tenant_id", "principal_id" });

            migrationBuilder.CreateIndex(
                name: "IX_push_subscription_tenant_id_principal_id_endpoint",
                table: "push_subscription",
                columns: new[] { "tenant_id", "principal_id", "endpoint" },
                unique: true);

            NotificationsSecuritySql.Apply(sql => migrationBuilder.Sql(sql));
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "notification");

            migrationBuilder.DropTable(
                name: "principal_preferences");

            migrationBuilder.DropTable(
                name: "push_subscription");
        }
    }
}
