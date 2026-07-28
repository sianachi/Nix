using System;
using System.Net;
using Microsoft.EntityFrameworkCore.Migrations;
using Nix.Persistence.Migrations;
// ReSharper disable All

#nullable disable

namespace Nix.Persistence.Migrations.Generated
{
    /// <inheritdoc />
    public partial class M0Schema : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.CreateTable(
                name: "tenant",
                columns: table => new
                {
                    tenant_id = table.Column<Guid>(type: "uuid", nullable: false),
                    name = table.Column<string>(type: "text", nullable: false),
                    isolation_mode = table.Column<string>(type: "text", nullable: false),
                    created_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_tenant", x => x.tenant_id);
                });

            migrationBuilder.CreateTable(
                name: "audit_event",
                columns: table => new
                {
                    event_id = table.Column<Guid>(type: "uuid", nullable: false),
                    tenant_id = table.Column<Guid>(type: "uuid", nullable: false),
                    workspace_id = table.Column<Guid>(type: "uuid", nullable: true),
                    actor_id = table.Column<Guid>(type: "uuid", nullable: false),
                    on_behalf_of = table.Column<Guid>(type: "uuid", nullable: true),
                    action = table.Column<string>(type: "text", nullable: false),
                    subject_id = table.Column<Guid>(type: "uuid", nullable: false),
                    subject_type = table.Column<string>(type: "text", nullable: false),
                    before = table.Column<string>(type: "jsonb", nullable: true),
                    after = table.Column<string>(type: "jsonb", nullable: true),
                    actor_ip = table.Column<IPAddress>(type: "inet", nullable: true),
                    occurred_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_audit_event", x => x.event_id);
                    table.ForeignKey(
                        name: "FK_audit_event_tenant_tenant_id",
                        column: x => x.tenant_id,
                        principalTable: "tenant",
                        principalColumn: "tenant_id",
                        onDelete: ReferentialAction.Restrict);
                });

            migrationBuilder.CreateTable(
                name: "identity_provider",
                columns: table => new
                {
                    provider_id = table.Column<Guid>(type: "uuid", nullable: false),
                    tenant_id = table.Column<Guid>(type: "uuid", nullable: false),
                    issuer = table.Column<string>(type: "text", nullable: false),
                    audience = table.Column<string>(type: "text", nullable: false),
                    jwks_uri = table.Column<string>(type: "text", nullable: false),
                    allowed_algorithms = table.Column<string[]>(type: "text[]", nullable: false),
                    enabled = table.Column<bool>(type: "boolean", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_identity_provider", x => x.provider_id);
                    table.ForeignKey(
                        name: "FK_identity_provider_tenant_tenant_id",
                        column: x => x.tenant_id,
                        principalTable: "tenant",
                        principalColumn: "tenant_id",
                        onDelete: ReferentialAction.Restrict);
                });

            migrationBuilder.CreateTable(
                name: "principal",
                columns: table => new
                {
                    principal_id = table.Column<Guid>(type: "uuid", nullable: false),
                    tenant_id = table.Column<Guid>(type: "uuid", nullable: false),
                    external_subject = table.Column<string>(type: "text", nullable: false),
                    kind = table.Column<string>(type: "text", nullable: false),
                    display_name = table.Column<string>(type: "text", nullable: false),
                    email = table.Column<string>(type: "text", nullable: true),
                    status = table.Column<string>(type: "text", nullable: false),
                    deprovisioned_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_principal", x => x.principal_id);
                    table.UniqueConstraint("AK_principal_tenant_id_principal_id", x => new { x.tenant_id, x.principal_id });
                    table.ForeignKey(
                        name: "FK_principal_tenant_tenant_id",
                        column: x => x.tenant_id,
                        principalTable: "tenant",
                        principalColumn: "tenant_id",
                        onDelete: ReferentialAction.Restrict);
                });

            migrationBuilder.CreateTable(
                name: "principal_group",
                columns: table => new
                {
                    group_id = table.Column<Guid>(type: "uuid", nullable: false),
                    tenant_id = table.Column<Guid>(type: "uuid", nullable: false),
                    name = table.Column<string>(type: "text", nullable: false),
                    external_id = table.Column<string>(type: "text", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_principal_group", x => x.group_id);
                    table.UniqueConstraint("AK_principal_group_tenant_id_group_id", x => new { x.tenant_id, x.group_id });
                    table.ForeignKey(
                        name: "FK_principal_group_tenant_tenant_id",
                        column: x => x.tenant_id,
                        principalTable: "tenant",
                        principalColumn: "tenant_id",
                        onDelete: ReferentialAction.Restrict);
                });

            migrationBuilder.CreateTable(
                name: "tenant_role",
                columns: table => new
                {
                    tenant_id = table.Column<Guid>(type: "uuid", nullable: false),
                    subject_type = table.Column<string>(type: "text", nullable: false),
                    subject_id = table.Column<Guid>(type: "uuid", nullable: false),
                    role = table.Column<string>(type: "text", nullable: false),
                    granted_by = table.Column<Guid>(type: "uuid", nullable: false),
                    granted_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_tenant_role", x => new { x.tenant_id, x.subject_type, x.subject_id });
                    table.ForeignKey(
                        name: "FK_tenant_role_tenant_tenant_id",
                        column: x => x.tenant_id,
                        principalTable: "tenant",
                        principalColumn: "tenant_id",
                        onDelete: ReferentialAction.Restrict);
                });

            migrationBuilder.CreateTable(
                name: "workspace",
                columns: table => new
                {
                    workspace_id = table.Column<Guid>(type: "uuid", nullable: false),
                    tenant_id = table.Column<Guid>(type: "uuid", nullable: false),
                    name = table.Column<string>(type: "text", nullable: false),
                    version_retention_days = table.Column<int>(type: "integer", nullable: false),
                    coalesce_window_min = table.Column<int>(type: "integer", nullable: false),
                    storage_quota_bytes = table.Column<long>(type: "bigint", nullable: false),
                    created_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_workspace", x => x.workspace_id);
                    table.UniqueConstraint("AK_workspace_tenant_id_workspace_id", x => new { x.tenant_id, x.workspace_id });
                    table.ForeignKey(
                        name: "FK_workspace_tenant_tenant_id",
                        column: x => x.tenant_id,
                        principalTable: "tenant",
                        principalColumn: "tenant_id",
                        onDelete: ReferentialAction.Restrict);
                });

            migrationBuilder.CreateTable(
                name: "group_membership",
                columns: table => new
                {
                    group_id = table.Column<Guid>(type: "uuid", nullable: false),
                    principal_id = table.Column<Guid>(type: "uuid", nullable: false),
                    tenant_id = table.Column<Guid>(type: "uuid", nullable: false),
                    source = table.Column<string>(type: "text", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_group_membership", x => new { x.group_id, x.principal_id });
                    table.ForeignKey(
                        name: "FK_group_membership_principal_group_tenant_id_group_id",
                        columns: x => new { x.tenant_id, x.group_id },
                        principalTable: "principal_group",
                        principalColumns: new[] { "tenant_id", "group_id" },
                        onDelete: ReferentialAction.Cascade);
                    table.ForeignKey(
                        name: "FK_group_membership_principal_tenant_id_principal_id",
                        columns: x => new { x.tenant_id, x.principal_id },
                        principalTable: "principal",
                        principalColumns: new[] { "tenant_id", "principal_id" },
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateTable(
                name: "item",
                columns: table => new
                {
                    id = table.Column<Guid>(type: "uuid", nullable: false),
                    tenant_id = table.Column<Guid>(type: "uuid", nullable: false),
                    workspace_id = table.Column<Guid>(type: "uuid", nullable: false),
                    type = table.Column<string>(type: "text", nullable: false),
                    parent_id = table.Column<Guid>(type: "uuid", nullable: true),
                    seq = table.Column<long>(type: "bigint", nullable: false),
                    properties = table.Column<string>(type: "jsonb", nullable: true),
                    lifecycle_state = table.Column<string>(type: "text", nullable: false),
                    purge_after = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true),
                    created_by = table.Column<Guid>(type: "uuid", nullable: false),
                    last_modified_by = table.Column<Guid>(type: "uuid", nullable: false),
                    created_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    last_modified_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_item", x => x.id);
                    table.UniqueConstraint("AK_item_tenant_id_id", x => new { x.tenant_id, x.id });
                    table.ForeignKey(
                        name: "FK_item_item_tenant_id_parent_id",
                        columns: x => new { x.tenant_id, x.parent_id },
                        principalTable: "item",
                        principalColumns: new[] { "tenant_id", "id" },
                        onDelete: ReferentialAction.Restrict);
                    table.ForeignKey(
                        name: "FK_item_workspace_tenant_id_workspace_id",
                        columns: x => new { x.tenant_id, x.workspace_id },
                        principalTable: "workspace",
                        principalColumns: new[] { "tenant_id", "workspace_id" },
                        onDelete: ReferentialAction.Restrict);
                });

            migrationBuilder.CreateTable(
                name: "workspace_member",
                columns: table => new
                {
                    workspace_id = table.Column<Guid>(type: "uuid", nullable: false),
                    subject_type = table.Column<string>(type: "text", nullable: false),
                    subject_id = table.Column<Guid>(type: "uuid", nullable: false),
                    tenant_id = table.Column<Guid>(type: "uuid", nullable: false),
                    role = table.Column<string>(type: "text", nullable: false),
                    granted_by = table.Column<Guid>(type: "uuid", nullable: false),
                    granted_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_workspace_member", x => new { x.workspace_id, x.subject_type, x.subject_id });
                    table.ForeignKey(
                        name: "FK_workspace_member_workspace_tenant_id_workspace_id",
                        columns: x => new { x.tenant_id, x.workspace_id },
                        principalTable: "workspace",
                        principalColumns: new[] { "tenant_id", "workspace_id" },
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateTable(
                name: "acl_entry",
                columns: table => new
                {
                    acl_entry_id = table.Column<Guid>(type: "uuid", nullable: false),
                    item_id = table.Column<Guid>(type: "uuid", nullable: false),
                    tenant_id = table.Column<Guid>(type: "uuid", nullable: false),
                    workspace_id = table.Column<Guid>(type: "uuid", nullable: false),
                    subject_type = table.Column<string>(type: "text", nullable: false),
                    subject_id = table.Column<Guid>(type: "uuid", nullable: false),
                    role = table.Column<string>(type: "text", nullable: false),
                    effect = table.Column<string>(type: "text", nullable: false),
                    breaks_inheritance = table.Column<bool>(type: "boolean", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_acl_entry", x => x.acl_entry_id);
                    table.ForeignKey(
                        name: "FK_acl_entry_item_tenant_id_item_id",
                        columns: x => new { x.tenant_id, x.item_id },
                        principalTable: "item",
                        principalColumns: new[] { "tenant_id", "id" },
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateTable(
                name: "item_closure",
                columns: table => new
                {
                    descendant_id = table.Column<Guid>(type: "uuid", nullable: false),
                    ancestor_id = table.Column<Guid>(type: "uuid", nullable: false),
                    tenant_id = table.Column<Guid>(type: "uuid", nullable: false),
                    workspace_id = table.Column<Guid>(type: "uuid", nullable: false),
                    depth = table.Column<int>(type: "integer", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_item_closure", x => new { x.descendant_id, x.ancestor_id });
                    table.ForeignKey(
                        name: "FK_item_closure_item_tenant_id_ancestor_id",
                        columns: x => new { x.tenant_id, x.ancestor_id },
                        principalTable: "item",
                        principalColumns: new[] { "tenant_id", "id" },
                        onDelete: ReferentialAction.Cascade);
                    table.ForeignKey(
                        name: "FK_item_closure_item_tenant_id_descendant_id",
                        columns: x => new { x.tenant_id, x.descendant_id },
                        principalTable: "item",
                        principalColumns: new[] { "tenant_id", "id" },
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateIndex(
                name: "IX_acl_entry_item_id_subject_type_subject_id_effect",
                table: "acl_entry",
                columns: new[] { "item_id", "subject_type", "subject_id", "effect" },
                unique: true);

            migrationBuilder.CreateIndex(
                name: "IX_acl_entry_tenant_id_item_id",
                table: "acl_entry",
                columns: new[] { "tenant_id", "item_id" });

            migrationBuilder.CreateIndex(
                name: "IX_acl_entry_tenant_id_subject_type_subject_id",
                table: "acl_entry",
                columns: new[] { "tenant_id", "subject_type", "subject_id" });

            migrationBuilder.CreateIndex(
                name: "IX_audit_event_tenant_id_occurred_at",
                table: "audit_event",
                columns: new[] { "tenant_id", "occurred_at" });

            migrationBuilder.CreateIndex(
                name: "IX_group_membership_tenant_id_group_id",
                table: "group_membership",
                columns: new[] { "tenant_id", "group_id" });

            migrationBuilder.CreateIndex(
                name: "IX_group_membership_tenant_id_principal_id",
                table: "group_membership",
                columns: new[] { "tenant_id", "principal_id" });

            migrationBuilder.CreateIndex(
                name: "IX_identity_provider_issuer_audience",
                table: "identity_provider",
                columns: new[] { "issuer", "audience" },
                unique: true);

            migrationBuilder.CreateIndex(
                name: "IX_identity_provider_tenant_id",
                table: "identity_provider",
                column: "tenant_id");

            migrationBuilder.CreateIndex(
                name: "IX_item_tenant_id_parent_id",
                table: "item",
                columns: new[] { "tenant_id", "parent_id" });

            migrationBuilder.CreateIndex(
                name: "IX_item_tenant_id_workspace_id",
                table: "item",
                columns: new[] { "tenant_id", "workspace_id" });

            migrationBuilder.CreateIndex(
                name: "IX_item_workspace_id_parent_id_seq",
                table: "item",
                columns: new[] { "workspace_id", "parent_id", "seq" });

            migrationBuilder.CreateIndex(
                name: "IX_item_closure_tenant_id_ancestor_id_depth",
                table: "item_closure",
                columns: new[] { "tenant_id", "ancestor_id", "depth" });

            migrationBuilder.CreateIndex(
                name: "IX_item_closure_tenant_id_descendant_id",
                table: "item_closure",
                columns: new[] { "tenant_id", "descendant_id" });

            migrationBuilder.CreateIndex(
                name: "IX_principal_tenant_id_external_subject",
                table: "principal",
                columns: new[] { "tenant_id", "external_subject" },
                unique: true);

            migrationBuilder.CreateIndex(
                name: "IX_principal_group_tenant_id_external_id",
                table: "principal_group",
                columns: new[] { "tenant_id", "external_id" },
                unique: true,
                filter: "external_id IS NOT NULL");

            migrationBuilder.CreateIndex(
                name: "IX_workspace_member_tenant_id_subject_type_subject_id",
                table: "workspace_member",
                columns: new[] { "tenant_id", "subject_type", "subject_id" });

            migrationBuilder.CreateIndex(
                name: "IX_workspace_member_tenant_id_workspace_id",
                table: "workspace_member",
                columns: new[] { "tenant_id", "workspace_id" });

            // Row-level security, grants, payload bounds, and the pre-authentication identity
            // provider resolver. Hand-authored, and deliberately kept outside this folder so a
            // future `migrations remove` cannot delete the only thing isolating these tables.
            // If a scaffold drops this line, the isolation suite fails on the next run.
            M0SchemaSecuritySql.Apply(sql => migrationBuilder.Sql(sql));
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "acl_entry");

            migrationBuilder.DropTable(
                name: "audit_event");

            migrationBuilder.DropTable(
                name: "group_membership");

            migrationBuilder.DropTable(
                name: "identity_provider");

            migrationBuilder.DropTable(
                name: "item_closure");

            migrationBuilder.DropTable(
                name: "tenant_role");

            migrationBuilder.DropTable(
                name: "workspace_member");

            migrationBuilder.DropTable(
                name: "principal_group");

            migrationBuilder.DropTable(
                name: "principal");

            migrationBuilder.DropTable(
                name: "item");

            migrationBuilder.DropTable(
                name: "workspace");

            migrationBuilder.DropTable(
                name: "tenant");
        }
    }
}
