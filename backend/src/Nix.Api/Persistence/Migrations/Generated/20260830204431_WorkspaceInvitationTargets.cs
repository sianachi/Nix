using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Nix.Persistence.Migrations.Generated
{
    /// <inheritdoc />
    public partial class WorkspaceInvitationTargets : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<Guid>(
                name: "target_principal_id",
                table: "workspace_invitation",
                type: "uuid",
                nullable: true);

            migrationBuilder.Sql("""
                UPDATE workspace_invitation
                   SET target_principal_id = accepted_by_principal_id
                 WHERE status = 'accepted'
                   AND accepted_by_principal_id IS NOT NULL;

                CREATE OR REPLACE FUNCTION nix_guard_workspace_invitation_transition()
                RETURNS trigger
                LANGUAGE plpgsql
                SET search_path = public, pg_temp
                AS $$
                BEGIN
                    IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id THEN
                        RAISE EXCEPTION 'workspace invitation identity is immutable'
                            USING ERRCODE = 'check_violation';
                    END IF;

                    IF NEW.invitation_id IS DISTINCT FROM OLD.invitation_id
                       OR NEW.workspace_id IS DISTINCT FROM OLD.workspace_id
                       OR NEW.email_normalized IS DISTINCT FROM OLD.email_normalized
                       OR NEW.target_principal_id IS DISTINCT FROM OLD.target_principal_id
                       OR NEW.role IS DISTINCT FROM OLD.role
                       OR NEW.invited_by_principal_id IS DISTINCT FROM OLD.invited_by_principal_id
                       OR NEW.invited_at IS DISTINCT FROM OLD.invited_at THEN
                        RAISE EXCEPTION 'workspace invitation identity is immutable'
                            USING ERRCODE = 'check_violation';
                    END IF;

                    IF OLD.status <> 'pending' AND NEW IS DISTINCT FROM OLD THEN
                        RAISE EXCEPTION 'accepted and revoked workspace invitations are terminal'
                            USING ERRCODE = 'check_violation';
                    END IF;

                    IF OLD.status = 'pending'
                       AND NEW.status NOT IN ('pending', 'accepted', 'revoked') THEN
                        RAISE EXCEPTION 'invalid workspace invitation transition'
                            USING ERRCODE = 'check_violation';
                    END IF;

                    RETURN NEW;
                END
                $$;
                """);

            migrationBuilder.CreateIndex(
                name: "ix_workspace_invitation_pending_target",
                table: "workspace_invitation",
                columns: new[] { "tenant_id", "workspace_id", "target_principal_id" },
                unique: true,
                filter: "status = 'pending' AND target_principal_id IS NOT NULL");

            migrationBuilder.CreateIndex(
                name: "IX_workspace_invitation_tenant_id_target_principal_id",
                table: "workspace_invitation",
                columns: new[] { "tenant_id", "target_principal_id" });

            migrationBuilder.CreateIndex(
                name: "ix_principal_workspace_invitee",
                table: "principal",
                columns: new[] { "tenant_id", "principal_id" },
                filter: "kind = 'user' AND status = 'active' AND email_verified AND email_normalized IS NOT NULL AND email IS NOT NULL")
                .Annotation("Npgsql:IndexInclude", new[] { "display_name", "email" });

            migrationBuilder.AddForeignKey(
                name: "FK_workspace_invitation_principal_tenant_id_target_principal_id",
                table: "workspace_invitation",
                columns: new[] { "tenant_id", "target_principal_id" },
                principalTable: "principal",
                principalColumns: new[] { "tenant_id", "principal_id" },
                onDelete: ReferentialAction.Restrict);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.Sql("""
                CREATE OR REPLACE FUNCTION nix_guard_workspace_invitation_transition()
                RETURNS trigger
                LANGUAGE plpgsql
                SET search_path = public, pg_temp
                AS $$
                BEGIN
                    IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id THEN
                        RAISE EXCEPTION 'workspace invitation identity is immutable'
                            USING ERRCODE = 'check_violation';
                    END IF;

                    IF NEW.invitation_id IS DISTINCT FROM OLD.invitation_id
                       OR NEW.workspace_id IS DISTINCT FROM OLD.workspace_id
                       OR NEW.email_normalized IS DISTINCT FROM OLD.email_normalized
                       OR NEW.role IS DISTINCT FROM OLD.role
                       OR NEW.invited_by_principal_id IS DISTINCT FROM OLD.invited_by_principal_id
                       OR NEW.invited_at IS DISTINCT FROM OLD.invited_at THEN
                        RAISE EXCEPTION 'workspace invitation identity is immutable'
                            USING ERRCODE = 'check_violation';
                    END IF;

                    IF OLD.status <> 'pending' AND NEW IS DISTINCT FROM OLD THEN
                        RAISE EXCEPTION 'accepted and revoked workspace invitations are terminal'
                            USING ERRCODE = 'check_violation';
                    END IF;

                    IF OLD.status = 'pending'
                       AND NEW.status NOT IN ('pending', 'accepted', 'revoked') THEN
                        RAISE EXCEPTION 'invalid workspace invitation transition'
                            USING ERRCODE = 'check_violation';
                    END IF;

                    RETURN NEW;
                END
                $$;
                """);

            migrationBuilder.DropForeignKey(
                name: "FK_workspace_invitation_principal_tenant_id_target_principal_id",
                table: "workspace_invitation");

            migrationBuilder.DropIndex(
                name: "ix_workspace_invitation_pending_target",
                table: "workspace_invitation");

            migrationBuilder.DropIndex(
                name: "IX_workspace_invitation_tenant_id_target_principal_id",
                table: "workspace_invitation");

            migrationBuilder.DropIndex(
                name: "ix_principal_workspace_invitee",
                table: "principal");

            migrationBuilder.DropColumn(
                name: "target_principal_id",
                table: "workspace_invitation");
        }
    }
}
