using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Nix.Persistence.Migrations.Generated
{
    /// <inheritdoc />
    public partial class PersonalWorkspaceFoundation : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropIndex(
                name: "IX_workspace_member_tenant_id_subject_type_subject_id",
                table: "workspace_member");

            migrationBuilder.DropIndex(
                name: "IX_workspace_member_tenant_id_workspace_id",
                table: "workspace_member");

            migrationBuilder.DropIndex(
                name: "IX_principal_tenant_id_external_subject",
                table: "principal");

            migrationBuilder.AddColumn<Guid>(
                name: "personal_owner_principal_id",
                table: "workspace",
                type: "uuid",
                nullable: true);

            migrationBuilder.AddColumn<string>(
                name: "email_normalized",
                table: "principal",
                type: "text",
                nullable: true);

            migrationBuilder.AddColumn<bool>(
                name: "email_verified",
                table: "principal",
                type: "boolean",
                nullable: false,
                defaultValue: false);

            migrationBuilder.AddColumn<string>(
                name: "external_issuer",
                table: "principal",
                type: "text",
                nullable: true);

            migrationBuilder.AddColumn<bool>(
                name: "jit_provisioning_enabled",
                table: "identity_provider",
                type: "boolean",
                nullable: false,
                defaultValue: false);

            migrationBuilder.AddColumn<string>(
                name: "userinfo_uri",
                table: "identity_provider",
                type: "character varying(2048)",
                maxLength: 2048,
                nullable: true);

            migrationBuilder.CreateTable(
                name: "workspace_invitation",
                columns: table => new
                {
                    invitation_id = table.Column<Guid>(type: "uuid", nullable: false),
                    tenant_id = table.Column<Guid>(type: "uuid", nullable: false),
                    workspace_id = table.Column<Guid>(type: "uuid", nullable: false),
                    email_normalized = table.Column<string>(type: "character varying(320)", maxLength: 320, nullable: false),
                    role = table.Column<string>(type: "text", nullable: false),
                    invited_by_principal_id = table.Column<Guid>(type: "uuid", nullable: false),
                    status = table.Column<string>(type: "text", nullable: false),
                    invited_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    accepted_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true),
                    accepted_by_principal_id = table.Column<Guid>(type: "uuid", nullable: true),
                    revoked_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_workspace_invitation", x => x.invitation_id);
                    table.ForeignKey(
                        name: "FK_workspace_invitation_principal_tenant_id_accepted_by_princi~",
                        columns: x => new { x.tenant_id, x.accepted_by_principal_id },
                        principalTable: "principal",
                        principalColumns: new[] { "tenant_id", "principal_id" },
                        onDelete: ReferentialAction.Restrict);
                    table.ForeignKey(
                        name: "FK_workspace_invitation_principal_tenant_id_invited_by_princip~",
                        columns: x => new { x.tenant_id, x.invited_by_principal_id },
                        principalTable: "principal",
                        principalColumns: new[] { "tenant_id", "principal_id" },
                        onDelete: ReferentialAction.Restrict);
                    table.ForeignKey(
                        name: "FK_workspace_invitation_workspace_tenant_id_workspace_id",
                        columns: x => new { x.tenant_id, x.workspace_id },
                        principalTable: "workspace",
                        principalColumns: new[] { "tenant_id", "workspace_id" },
                        onDelete: ReferentialAction.Restrict);
                });

            migrationBuilder.CreateIndex(
                name: "ix_workspace_member_actor_reach",
                table: "workspace_member",
                columns: new[] { "tenant_id", "subject_type", "subject_id", "workspace_id" })
                .Annotation("Npgsql:IndexInclude", new[] { "role" });

            migrationBuilder.CreateIndex(
                name: "ix_workspace_member_history",
                table: "workspace_member",
                columns: new[] { "tenant_id", "workspace_id", "granted_at", "subject_type", "subject_id" },
                descending: new[] { false, false, true, false, false });

            migrationBuilder.CreateIndex(
                name: "ix_workspace_list",
                table: "workspace",
                columns: new[] { "tenant_id", "created_at", "workspace_id" },
                descending: new[] { false, true, true });

            migrationBuilder.CreateIndex(
                name: "IX_workspace_tenant_id_personal_owner_principal_id",
                table: "workspace",
                columns: new[] { "tenant_id", "personal_owner_principal_id" },
                unique: true,
                filter: "personal_owner_principal_id IS NOT NULL");

            migrationBuilder.CreateIndex(
                name: "IX_principal_tenant_id_email_normalized",
                table: "principal",
                columns: new[] { "tenant_id", "email_normalized" },
                filter: "kind = 'user' AND status = 'active' AND email_verified AND email_normalized IS NOT NULL");

            migrationBuilder.CreateIndex(
                name: "IX_principal_tenant_id_external_issuer_external_subject",
                table: "principal",
                columns: new[] { "tenant_id", "external_issuer", "external_subject" },
                unique: true,
                filter: "external_issuer IS NOT NULL");

            migrationBuilder.CreateIndex(
                name: "ix_workspace_invitation_history",
                table: "workspace_invitation",
                columns: new[] { "tenant_id", "workspace_id", "invited_at", "invitation_id" },
                descending: new[] { false, false, true, true });

            migrationBuilder.CreateIndex(
                name: "ix_workspace_invitation_pending_unique",
                table: "workspace_invitation",
                columns: new[] { "tenant_id", "workspace_id", "email_normalized" },
                unique: true,
                filter: "status = 'pending'");

            migrationBuilder.CreateIndex(
                name: "ix_workspace_invitation_redemption",
                table: "workspace_invitation",
                columns: new[] { "tenant_id", "email_normalized", "invited_at", "invitation_id" },
                filter: "status = 'pending'");

            migrationBuilder.CreateIndex(
                name: "IX_workspace_invitation_tenant_id_accepted_by_principal_id",
                table: "workspace_invitation",
                columns: new[] { "tenant_id", "accepted_by_principal_id" });

            migrationBuilder.CreateIndex(
                name: "IX_workspace_invitation_tenant_id_invited_by_principal_id",
                table: "workspace_invitation",
                columns: new[] { "tenant_id", "invited_by_principal_id" });

            migrationBuilder.AddForeignKey(
                name: "FK_workspace_principal_tenant_id_personal_owner_principal_id",
                table: "workspace",
                columns: new[] { "tenant_id", "personal_owner_principal_id" },
                principalTable: "principal",
                principalColumns: new[] { "tenant_id", "principal_id" },
                onDelete: ReferentialAction.Restrict);

            Nix.Persistence.Migrations.PersonalWorkspaceFoundationSecuritySql.Apply(
                sql => migrationBuilder.Sql(sql));
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            Nix.Persistence.Migrations.PersonalWorkspaceFoundationSecuritySql.Revert(
                sql => migrationBuilder.Sql(sql));

            migrationBuilder.DropForeignKey(
                name: "FK_workspace_principal_tenant_id_personal_owner_principal_id",
                table: "workspace");

            migrationBuilder.DropTable(
                name: "workspace_invitation");

            migrationBuilder.DropIndex(
                name: "ix_workspace_member_actor_reach",
                table: "workspace_member");

            migrationBuilder.DropIndex(
                name: "ix_workspace_member_history",
                table: "workspace_member");

            migrationBuilder.DropIndex(
                name: "ix_workspace_list",
                table: "workspace");

            migrationBuilder.DropIndex(
                name: "IX_workspace_tenant_id_personal_owner_principal_id",
                table: "workspace");

            migrationBuilder.DropIndex(
                name: "IX_principal_tenant_id_email_normalized",
                table: "principal");

            migrationBuilder.DropIndex(
                name: "IX_principal_tenant_id_external_issuer_external_subject",
                table: "principal");

            migrationBuilder.DropColumn(
                name: "personal_owner_principal_id",
                table: "workspace");

            migrationBuilder.DropColumn(
                name: "email_normalized",
                table: "principal");

            migrationBuilder.DropColumn(
                name: "email_verified",
                table: "principal");

            migrationBuilder.DropColumn(
                name: "external_issuer",
                table: "principal");

            migrationBuilder.DropColumn(
                name: "jit_provisioning_enabled",
                table: "identity_provider");

            migrationBuilder.DropColumn(
                name: "userinfo_uri",
                table: "identity_provider");

            migrationBuilder.CreateIndex(
                name: "IX_workspace_member_tenant_id_subject_type_subject_id",
                table: "workspace_member",
                columns: new[] { "tenant_id", "subject_type", "subject_id" });

            migrationBuilder.CreateIndex(
                name: "IX_workspace_member_tenant_id_workspace_id",
                table: "workspace_member",
                columns: new[] { "tenant_id", "workspace_id" });

            migrationBuilder.CreateIndex(
                name: "IX_principal_tenant_id_external_subject",
                table: "principal",
                columns: new[] { "tenant_id", "external_subject" },
                unique: true);
        }
    }
}
