using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Migrations;

namespace Nix.Persistence.Migrations.Generated;

/// <summary>Lets a site build record MP4 and WebM videos (at most 50 MiB) beside images and downloads.</summary>
[DbContext(typeof(NixDbContext))]
[Migration("20261016120000_SiteVideoFiles")]
public sealed class SiteVideoFiles : Migration
{
    private const string Images = "(media_type IN ('image/png', 'image/jpeg', 'image/webp') AND byte_length BETWEEN 1 AND 10485760)"
        + " OR (media_type = 'image/svg+xml' AND byte_length BETWEEN 1 AND 2097152)"
        + " OR (media_type IN ('application/pdf', 'text/plain', 'text/csv') AND byte_length BETWEEN 1 AND 20971520)";

    /// <inheritdoc />
    protected override void Up(MigrationBuilder migrationBuilder) => Replace(
        migrationBuilder,
        Images + " OR (media_type IN ('video/mp4', 'video/webm') AND byte_length BETWEEN 1 AND 52428800)");

    /// <inheritdoc />
    protected override void Down(MigrationBuilder migrationBuilder) => Replace(migrationBuilder, Images);

    private static void Replace(MigrationBuilder migrationBuilder, string allowed)
    {
        migrationBuilder.DropCheckConstraint("ck_site_build_file_bounded", "site_build_file");
        migrationBuilder.AddCheckConstraint(
            "ck_site_build_file_bounded",
            "site_build_file",
            "sha256 ~ '^[0-9a-f]{64}$' AND (" + allowed + ")");
    }
}
