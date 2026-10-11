using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Nix.Persistence.Migrations.Generated
{
    /// <inheritdoc />
#pragma warning disable CA1724 // Justification: EF derives the class from the migration name; the name Sites is the migration's identity and the Nix.Domain.Sites namespace is unrelated to it.
    public partial class Sites : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.CreateTable(
                name: "site",
                columns: table => new
                {
                    tenant_id = table.Column<Guid>(type: "uuid", nullable: false),
                    id = table.Column<Guid>(type: "uuid", nullable: false),
                    workspace_id = table.Column<Guid>(type: "uuid", nullable: false),
                    root_item_id = table.Column<Guid>(type: "uuid", nullable: false),
                    slug = table.Column<string>(type: "character varying(40)", maxLength: 40, nullable: false),
                    layout = table.Column<string>(type: "character varying(8)", maxLength: 8, nullable: false),
                    settings = table.Column<string>(type: "jsonb", nullable: false),
                    republish_mode = table.Column<string>(type: "character varying(16)", maxLength: 16, nullable: false),
                    auto_principal_id = table.Column<Guid>(type: "uuid", nullable: true),
                    debounce_seconds = table.Column<int>(type: "integer", nullable: false),
                    status = table.Column<string>(type: "character varying(16)", maxLength: 16, nullable: false),
                    live_build_id = table.Column<Guid>(type: "uuid", nullable: true),
                    primary_hostname = table.Column<string>(type: "character varying(253)", maxLength: 253, nullable: true),
                    approval_state = table.Column<string>(type: "character varying(16)", maxLength: 16, nullable: true),
                    approval_requested_by = table.Column<Guid>(type: "uuid", nullable: true),
                    approval_requested_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true),
                    approval_decided_by = table.Column<Guid>(type: "uuid", nullable: true),
                    approval_decided_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true),
                    approval_note = table.Column<string>(type: "character varying(500)", maxLength: 500, nullable: true),
                    created_by = table.Column<Guid>(type: "uuid", nullable: false),
                    created_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    updated_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_site", x => new { x.tenant_id, x.id });
                    table.CheckConstraint("ck_site_bounded", "slug ~ '^[a-z0-9](-?[a-z0-9]){1,39}$' AND layout IN ('docs', 'blog') AND republish_mode IN ('manual', 'auto', 'on_release') AND status IN ('draft', 'published', 'unpublished') AND debounce_seconds BETWEEN 60 AND 3600 AND (republish_mode <> 'auto' OR auto_principal_id IS NOT NULL) AND (status = 'published') = (live_build_id IS NOT NULL) AND pg_column_size(settings) <= 16384 AND (primary_hostname IS NULL OR char_length(primary_hostname) BETWEEN 3 AND 253) AND (approval_state IS NULL OR approval_state IN ('pending', 'approved', 'rejected')) AND (approval_state IS NULL OR (approval_requested_by IS NOT NULL AND approval_requested_at IS NOT NULL)) AND (approval_note IS NULL OR char_length(approval_note) <= 500)");
                    table.ForeignKey(
                        name: "fk_site_auto_principal",
                        columns: x => new { x.tenant_id, x.auto_principal_id },
                        principalTable: "principal",
                        principalColumns: new[] { "tenant_id", "principal_id" },
                        onDelete: ReferentialAction.Restrict);
                    table.ForeignKey(
                        name: "fk_site_created_by",
                        columns: x => new { x.tenant_id, x.created_by },
                        principalTable: "principal",
                        principalColumns: new[] { "tenant_id", "principal_id" },
                        onDelete: ReferentialAction.Restrict);
                    table.ForeignKey(
                        name: "fk_site_root_item",
                        columns: x => new { x.tenant_id, x.root_item_id },
                        principalTable: "item",
                        principalColumns: new[] { "tenant_id", "id" },
                        onDelete: ReferentialAction.Restrict);
                    table.ForeignKey(
                        name: "fk_site_workspace",
                        columns: x => new { x.tenant_id, x.workspace_id },
                        principalTable: "workspace",
                        principalColumns: new[] { "tenant_id", "workspace_id" },
                        onDelete: ReferentialAction.Restrict);
                });

            migrationBuilder.CreateTable(
                name: "site_build",
                columns: table => new
                {
                    tenant_id = table.Column<Guid>(type: "uuid", nullable: false),
                    id = table.Column<Guid>(type: "uuid", nullable: false),
                    site_id = table.Column<Guid>(type: "uuid", nullable: false),
                    status = table.Column<string>(type: "character varying(16)", maxLength: 16, nullable: false),
                    job_id = table.Column<Guid>(type: "uuid", nullable: false),
                    publisher_id = table.Column<Guid>(type: "uuid", nullable: false),
                    origin = table.Column<string>(type: "character varying(8)", maxLength: 8, nullable: false),
                    idempotency_key = table.Column<string>(type: "character varying(160)", maxLength: 160, nullable: false),
                    header = table.Column<string>(type: "jsonb", nullable: false),
                    page_count = table.Column<int>(type: "integer", nullable: false),
                    file_count = table.Column<int>(type: "integer", nullable: false),
                    total_bytes = table.Column<long>(type: "bigint", nullable: false),
                    loss = table.Column<string>(type: "jsonb", nullable: false),
                    build_index_sha256 = table.Column<string>(type: "character varying(64)", maxLength: 64, nullable: true),
                    purge_id = table.Column<Guid>(type: "uuid", nullable: true),
                    created_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    sealed_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true),
                    activated_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_site_build", x => new { x.tenant_id, x.id });
                    table.CheckConstraint("ck_site_build_bounded", "status IN ('queued', 'sealed', 'live', 'superseded', 'failed', 'purged') AND origin IN ('manual', 'auto') AND page_count BETWEEN 0 AND 5000 AND file_count >= 0 AND total_bytes >= 0 AND char_length(idempotency_key) BETWEEN 1 AND 160 AND jsonb_typeof(loss) = 'array' AND (build_index_sha256 IS NULL OR build_index_sha256 ~ '^[0-9a-f]{64}$')");
                    table.ForeignKey(
                        name: "fk_site_build_publisher",
                        columns: x => new { x.tenant_id, x.publisher_id },
                        principalTable: "principal",
                        principalColumns: new[] { "tenant_id", "principal_id" },
                        onDelete: ReferentialAction.Restrict);
                    table.ForeignKey(
                        name: "fk_site_build_site",
                        columns: x => new { x.tenant_id, x.site_id },
                        principalTable: "site",
                        principalColumns: new[] { "tenant_id", "id" },
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateTable(
                name: "site_dated_collection",
                columns: table => new
                {
                    tenant_id = table.Column<Guid>(type: "uuid", nullable: false),
                    site_id = table.Column<Guid>(type: "uuid", nullable: false),
                    item_id = table.Column<Guid>(type: "uuid", nullable: false),
                    date_property = table.Column<string>(type: "character varying(128)", maxLength: 128, nullable: false),
                    tags_property = table.Column<string>(type: "character varying(128)", maxLength: 128, nullable: true),
                    cover_property = table.Column<string>(type: "character varying(128)", maxLength: 128, nullable: true),
                    summary_property = table.Column<string>(type: "character varying(128)", maxLength: 128, nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_site_dated_collection", x => new { x.tenant_id, x.site_id, x.item_id });
                    table.CheckConstraint("ck_site_dated_collection_bounded", "char_length(date_property) BETWEEN 1 AND 128 AND (tags_property IS NULL OR char_length(tags_property) BETWEEN 1 AND 128) AND (cover_property IS NULL OR char_length(cover_property) BETWEEN 1 AND 128) AND (summary_property IS NULL OR char_length(summary_property) BETWEEN 1 AND 128)");
                    table.ForeignKey(
                        name: "fk_site_dated_collection_item",
                        columns: x => new { x.tenant_id, x.item_id },
                        principalTable: "item",
                        principalColumns: new[] { "tenant_id", "id" },
                        onDelete: ReferentialAction.Cascade);
                    table.ForeignKey(
                        name: "fk_site_dated_collection_site",
                        columns: x => new { x.tenant_id, x.site_id },
                        principalTable: "site",
                        principalColumns: new[] { "tenant_id", "id" },
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateTable(
                name: "site_exclusion",
                columns: table => new
                {
                    tenant_id = table.Column<Guid>(type: "uuid", nullable: false),
                    site_id = table.Column<Guid>(type: "uuid", nullable: false),
                    item_id = table.Column<Guid>(type: "uuid", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_site_exclusion", x => new { x.tenant_id, x.site_id, x.item_id });
                    table.ForeignKey(
                        name: "fk_site_exclusion_item",
                        columns: x => new { x.tenant_id, x.item_id },
                        principalTable: "item",
                        principalColumns: new[] { "tenant_id", "id" },
                        onDelete: ReferentialAction.Cascade);
                    table.ForeignKey(
                        name: "fk_site_exclusion_site",
                        columns: x => new { x.tenant_id, x.site_id },
                        principalTable: "site",
                        principalColumns: new[] { "tenant_id", "id" },
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateTable(
                name: "site_hostname",
                columns: table => new
                {
                    tenant_id = table.Column<Guid>(type: "uuid", nullable: false),
                    hostname = table.Column<string>(type: "character varying(253)", maxLength: 253, nullable: false),
                    site_id = table.Column<Guid>(type: "uuid", nullable: false),
                    kind = table.Column<string>(type: "character varying(8)", maxLength: 8, nullable: false),
                    verified_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true),
                    created_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    verification_token = table.Column<string>(type: "character varying(32)", maxLength: 32, nullable: true),
                    serve_mode = table.Column<string>(type: "character varying(8)", maxLength: 8, nullable: false, defaultValue: "serve"),
                    checked_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true),
                    check_failures = table.Column<int>(type: "integer", nullable: false, defaultValue: 0),
                    check_error = table.Column<string>(type: "character varying(64)", maxLength: 64, nullable: true),
                    managed_records = table.Column<string>(type: "jsonb", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_site_hostname", x => new { x.tenant_id, x.site_id, x.hostname });
                    table.CheckConstraint("ck_site_hostname_bounded", "char_length(hostname) BETWEEN 3 AND 253 AND hostname = lower(hostname) AND kind IN ('default', 'custom') AND (kind = 'custom' OR verified_at IS NOT NULL) AND serve_mode IN ('serve', 'redirect') AND (kind = 'default' OR (verification_token IS NOT NULL AND verification_token ~ '^[0-9a-f]{32}$')) AND check_failures BETWEEN 0 AND 10 AND (check_error IS NULL OR char_length(check_error) <= 64) AND (managed_records IS NULL OR (jsonb_typeof(managed_records) = 'object' AND pg_column_size(managed_records) <= 2048))");
                    table.ForeignKey(
                        name: "fk_site_hostname_site",
                        columns: x => new { x.tenant_id, x.site_id },
                        principalTable: "site",
                        principalColumns: new[] { "tenant_id", "id" },
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateTable(
                name: "site_page",
                columns: table => new
                {
                    tenant_id = table.Column<Guid>(type: "uuid", nullable: false),
                    site_id = table.Column<Guid>(type: "uuid", nullable: false),
                    item_id = table.Column<Guid>(type: "uuid", nullable: false),
                    path = table.Column<string>(type: "character varying(512)", maxLength: 512, nullable: false),
                    pinned = table.Column<bool>(type: "boolean", nullable: false),
                    created_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    updated_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_site_page", x => new { x.tenant_id, x.site_id, x.item_id });
                    table.CheckConstraint("ck_site_page_path", "path ~ '^/([a-z0-9][a-z0-9-]{0,79}/)*$' AND char_length(path) <= 512");
                    table.ForeignKey(
                        name: "fk_site_page_item",
                        columns: x => new { x.tenant_id, x.item_id },
                        principalTable: "item",
                        principalColumns: new[] { "tenant_id", "id" },
                        onDelete: ReferentialAction.Cascade);
                    table.ForeignKey(
                        name: "fk_site_page_site",
                        columns: x => new { x.tenant_id, x.site_id },
                        principalTable: "site",
                        principalColumns: new[] { "tenant_id", "id" },
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateTable(
                name: "site_redirect",
                columns: table => new
                {
                    tenant_id = table.Column<Guid>(type: "uuid", nullable: false),
                    site_id = table.Column<Guid>(type: "uuid", nullable: false),
                    from_path = table.Column<string>(type: "character varying(512)", maxLength: 512, nullable: false),
                    item_id = table.Column<Guid>(type: "uuid", nullable: false),
                    created_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_site_redirect", x => new { x.tenant_id, x.site_id, x.from_path });
                    table.CheckConstraint("ck_site_redirect_path", "from_path ~ '^/([a-z0-9][a-z0-9-]{0,79}/)+$' AND char_length(from_path) <= 512");
                    table.ForeignKey(
                        name: "fk_site_redirect_item",
                        columns: x => new { x.tenant_id, x.item_id },
                        principalTable: "item",
                        principalColumns: new[] { "tenant_id", "id" },
                        onDelete: ReferentialAction.Cascade);
                    table.ForeignKey(
                        name: "fk_site_redirect_site",
                        columns: x => new { x.tenant_id, x.site_id },
                        principalTable: "site",
                        principalColumns: new[] { "tenant_id", "id" },
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateTable(
                name: "site_activation",
                columns: table => new
                {
                    tenant_id = table.Column<Guid>(type: "uuid", nullable: false),
                    id = table.Column<Guid>(type: "uuid", nullable: false),
                    site_id = table.Column<Guid>(type: "uuid", nullable: false),
                    job_id = table.Column<Guid>(type: "uuid", nullable: false),
                    build_id = table.Column<Guid>(type: "uuid", nullable: false),
                    reason = table.Column<string>(type: "character varying(16)", maxLength: 16, nullable: false),
                    generation = table.Column<int>(type: "integer", nullable: false),
                    ops = table.Column<string>(type: "jsonb", nullable: false),
                    created_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    applied_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_site_activation", x => new { x.tenant_id, x.id });
                    table.CheckConstraint("ck_site_activation_bounded", "reason IN ('publish', 'rollback', 'unpublish', 'hostnames') AND generation >= 1 AND jsonb_typeof(ops) = 'array'");
                    table.ForeignKey(
                        name: "fk_site_activation_build",
                        columns: x => new { x.tenant_id, x.build_id },
                        principalTable: "site_build",
                        principalColumns: new[] { "tenant_id", "id" },
                        onDelete: ReferentialAction.Cascade);
                    table.ForeignKey(
                        name: "fk_site_activation_site",
                        columns: x => new { x.tenant_id, x.site_id },
                        principalTable: "site",
                        principalColumns: new[] { "tenant_id", "id" },
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateTable(
                name: "site_build_file",
                columns: table => new
                {
                    tenant_id = table.Column<Guid>(type: "uuid", nullable: false),
                    build_id = table.Column<Guid>(type: "uuid", nullable: false),
                    source_item_id = table.Column<Guid>(type: "uuid", nullable: false),
                    file_item_id = table.Column<Guid>(type: "uuid", nullable: false),
                    file_version_id = table.Column<Guid>(type: "uuid", nullable: false),
                    sha256 = table.Column<string>(type: "character varying(64)", maxLength: 64, nullable: false),
                    media_type = table.Column<string>(type: "character varying(32)", maxLength: 32, nullable: false),
                    byte_length = table.Column<long>(type: "bigint", nullable: false),
                    created_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_site_build_file", x => new { x.tenant_id, x.build_id, x.source_item_id, x.file_item_id });
                    table.CheckConstraint("ck_site_build_file_bounded", "sha256 ~ '^[0-9a-f]{64}$' AND ((media_type IN ('image/png', 'image/jpeg', 'image/webp') AND byte_length BETWEEN 1 AND 10485760) OR (media_type = 'image/svg+xml' AND byte_length BETWEEN 1 AND 2097152) OR (media_type IN ('application/pdf', 'text/plain', 'text/csv') AND byte_length BETWEEN 1 AND 20971520))");
                    table.ForeignKey(
                        name: "fk_site_build_file_build",
                        columns: x => new { x.tenant_id, x.build_id },
                        principalTable: "site_build",
                        principalColumns: new[] { "tenant_id", "id" },
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateTable(
                name: "site_build_object",
                columns: table => new
                {
                    tenant_id = table.Column<Guid>(type: "uuid", nullable: false),
                    build_id = table.Column<Guid>(type: "uuid", nullable: false),
                    key = table.Column<string>(type: "character varying(700)", maxLength: 700, nullable: false),
                    sha256 = table.Column<string>(type: "character varying(64)", maxLength: 64, nullable: false),
                    byte_length = table.Column<long>(type: "bigint", nullable: false),
                    kind = table.Column<string>(type: "character varying(8)", maxLength: 8, nullable: false),
                    created_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_site_build_object", x => new { x.tenant_id, x.build_id, x.key });
                    table.CheckConstraint("ck_site_build_object_bounded", "kind IN ('build', 'asset') AND sha256 ~ '^[0-9a-f]{64}$' AND byte_length BETWEEN 0 AND 52428800 AND char_length(key) BETWEEN 1 AND 700");
                    table.ForeignKey(
                        name: "fk_site_build_object_build",
                        columns: x => new { x.tenant_id, x.build_id },
                        principalTable: "site_build",
                        principalColumns: new[] { "tenant_id", "id" },
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateTable(
                name: "site_build_page",
                columns: table => new
                {
                    tenant_id = table.Column<Guid>(type: "uuid", nullable: false),
                    build_id = table.Column<Guid>(type: "uuid", nullable: false),
                    ordinal = table.Column<int>(type: "integer", nullable: false),
                    item_id = table.Column<Guid>(type: "uuid", nullable: false),
                    parent_item_id = table.Column<Guid>(type: "uuid", nullable: true),
                    path = table.Column<string>(type: "character varying(512)", maxLength: 512, nullable: false),
                    title = table.Column<string>(type: "character varying(500)", maxLength: 500, nullable: false),
                    type = table.Column<string>(type: "text", nullable: false),
                    seq = table.Column<long>(type: "bigint", nullable: false),
                    item_created_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    item_updated_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    properties = table.Column<string>(type: "jsonb", nullable: false),
                    schema = table.Column<string>(type: "jsonb", nullable: true),
                    views = table.Column<string>(type: "jsonb", nullable: true),
                    chart = table.Column<string>(type: "jsonb", nullable: true),
                    doc_id = table.Column<Guid>(type: "uuid", nullable: true),
                    content_seq = table.Column<long>(type: "bigint", nullable: true),
                    dated_collection_id = table.Column<Guid>(type: "uuid", nullable: true),
                    published_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true),
                    property_files = table.Column<string>(type: "jsonb", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_site_build_page", x => new { x.tenant_id, x.build_id, x.ordinal });
                    table.CheckConstraint("ck_site_build_page_bounded", "ordinal >= 0 AND path ~ '^/([a-z0-9][a-z0-9-]{0,79}/)*$' AND char_length(title) <= 500 AND jsonb_typeof(properties) = 'object' AND jsonb_typeof(property_files) = 'array'");
                    table.ForeignKey(
                        name: "fk_site_build_page_build",
                        columns: x => new { x.tenant_id, x.build_id },
                        principalTable: "site_build",
                        principalColumns: new[] { "tenant_id", "id" },
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateIndex(
                name: "ix_site_approval_pending",
                table: "site",
                columns: new[] { "tenant_id", "approval_requested_at" },
                filter: "approval_state = 'pending'");

            migrationBuilder.CreateIndex(
                name: "ix_site_auto_principal",
                table: "site",
                columns: new[] { "tenant_id", "auto_principal_id" },
                filter: "auto_principal_id IS NOT NULL");

            migrationBuilder.CreateIndex(
                name: "ix_site_created_by",
                table: "site",
                columns: new[] { "tenant_id", "created_by" });

            migrationBuilder.CreateIndex(
                name: "ix_site_workspace",
                table: "site",
                columns: new[] { "tenant_id", "workspace_id" });

            migrationBuilder.CreateIndex(
                name: "ux_site_root",
                table: "site",
                columns: new[] { "tenant_id", "root_item_id" },
                unique: true);

            migrationBuilder.CreateIndex(
                name: "ux_site_slug",
                table: "site",
                column: "slug",
                unique: true);

            migrationBuilder.CreateIndex(
                name: "ix_site_activation_build",
                table: "site_activation",
                columns: new[] { "tenant_id", "build_id" });

            migrationBuilder.CreateIndex(
                name: "ux_site_activation_generation",
                table: "site_activation",
                columns: new[] { "tenant_id", "site_id", "generation" },
                unique: true);

            migrationBuilder.CreateIndex(
                name: "ux_site_activation_job",
                table: "site_activation",
                columns: new[] { "tenant_id", "job_id" },
                unique: true);

            migrationBuilder.CreateIndex(
                name: "ix_site_build_publisher",
                table: "site_build",
                columns: new[] { "tenant_id", "publisher_id" });

            migrationBuilder.CreateIndex(
                name: "ix_site_build_purge",
                table: "site_build",
                columns: new[] { "tenant_id", "purge_id" },
                filter: "purge_id IS NOT NULL");

            migrationBuilder.CreateIndex(
                name: "ix_site_build_site_created",
                table: "site_build",
                columns: new[] { "tenant_id", "site_id", "created_at" },
                descending: new[] { false, false, true });

            migrationBuilder.CreateIndex(
                name: "ux_site_build_idempotency",
                table: "site_build",
                columns: new[] { "tenant_id", "site_id", "idempotency_key" },
                unique: true);

            migrationBuilder.CreateIndex(
                name: "ux_site_build_job",
                table: "site_build",
                columns: new[] { "tenant_id", "job_id" },
                unique: true);

            migrationBuilder.CreateIndex(
                name: "ix_site_build_object_asset",
                table: "site_build_object",
                columns: new[] { "tenant_id", "key" },
                filter: "kind = 'asset'");

            migrationBuilder.CreateIndex(
                name: "ux_site_build_page_item",
                table: "site_build_page",
                columns: new[] { "tenant_id", "build_id", "item_id" },
                unique: true);

            migrationBuilder.CreateIndex(
                name: "ix_site_dated_collection_item",
                table: "site_dated_collection",
                columns: new[] { "tenant_id", "item_id" });

            migrationBuilder.CreateIndex(
                name: "ix_site_exclusion_item",
                table: "site_exclusion",
                columns: new[] { "tenant_id", "item_id" });

            migrationBuilder.CreateIndex(
                name: "ix_site_hostname_site",
                table: "site_hostname",
                columns: new[] { "tenant_id", "site_id" });

            migrationBuilder.CreateIndex(
                name: "ux_site_hostname_verified",
                table: "site_hostname",
                column: "hostname",
                unique: true,
                filter: "verified_at IS NOT NULL");

            migrationBuilder.CreateIndex(
                name: "ix_site_page_item",
                table: "site_page",
                columns: new[] { "tenant_id", "item_id" });

            migrationBuilder.CreateIndex(
                name: "ux_site_page_path",
                table: "site_page",
                columns: new[] { "tenant_id", "site_id", "path" },
                unique: true);

            migrationBuilder.CreateIndex(
                name: "ix_site_redirect_item",
                table: "site_redirect",
                columns: new[] { "tenant_id", "item_id" });

            SitesSecuritySql.Apply(sql => migrationBuilder.Sql(sql));
            SitesHardeningSecuritySql.Apply(sql => migrationBuilder.Sql(sql));
            SitesHostingSecuritySql.Apply(sql => migrationBuilder.Sql(sql));
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            SitesHostingSecuritySql.Revert(sql => migrationBuilder.Sql(sql));
            SitesHardeningSecuritySql.Revert(sql => migrationBuilder.Sql(sql));
            SitesSecuritySql.Revert(sql => migrationBuilder.Sql(sql));

            migrationBuilder.DropTable(
                name: "site_activation");

            migrationBuilder.DropTable(
                name: "site_build_file");

            migrationBuilder.DropTable(
                name: "site_build_object");

            migrationBuilder.DropTable(
                name: "site_build_page");

            migrationBuilder.DropTable(
                name: "site_dated_collection");

            migrationBuilder.DropTable(
                name: "site_exclusion");

            migrationBuilder.DropTable(
                name: "site_hostname");

            migrationBuilder.DropTable(
                name: "site_page");

            migrationBuilder.DropTable(
                name: "site_redirect");

            migrationBuilder.DropTable(
                name: "site_build");

            migrationBuilder.DropTable(
                name: "site");
        }
    }
#pragma warning restore CA1724
}
