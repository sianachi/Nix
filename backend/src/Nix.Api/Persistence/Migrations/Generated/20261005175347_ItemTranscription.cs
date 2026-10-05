using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Nix.Persistence.Migrations.Generated
{
    /// <inheritdoc />
    public partial class ItemTranscription : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.CreateTable(
                name: "item_transcription",
                columns: table => new
                {
                    audio_item_id = table.Column<Guid>(type: "uuid", nullable: false),
                    tenant_id = table.Column<Guid>(type: "uuid", nullable: false),
                    workspace_id = table.Column<Guid>(type: "uuid", nullable: false),
                    note_item_id = table.Column<Guid>(type: "uuid", nullable: false),
                    job_id = table.Column<Guid>(type: "uuid", nullable: false),
                    speakers = table.Column<string>(type: "character varying(16)", maxLength: 16, nullable: false),
                    progress = table.Column<short>(type: "smallint", nullable: false),
                    requested_by = table.Column<Guid>(type: "uuid", nullable: false),
                    created_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    updated_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_item_transcription", x => x.audio_item_id);
                    table.ForeignKey(
                        name: "FK_item_transcription_item_tenant_id_audio_item_id",
                        columns: x => new { x.tenant_id, x.audio_item_id },
                        principalTable: "item",
                        principalColumns: new[] { "tenant_id", "id" },
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateIndex(
                name: "IX_item_transcription_tenant_id_audio_item_id",
                table: "item_transcription",
                columns: new[] { "tenant_id", "audio_item_id" });

            // The isolation policy, the grants and the bounds on item_transcription. Hand-authored
            // and kept outside this folder so a re-scaffold cannot delete it; if this call goes
            // missing, a table naming every recording a tenant has transcribed arrives unisolated.
            ItemTranscriptionSecuritySql.Apply(sql => migrationBuilder.Sql(sql));
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            ItemTranscriptionSecuritySql.Revert(sql => migrationBuilder.Sql(sql));

            migrationBuilder.DropTable(
                name: "item_transcription");
        }
    }
}
