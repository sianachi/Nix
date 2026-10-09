using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Migrations;

namespace Nix.Persistence.Migrations.Generated;

/// <summary>Retires pending transcription work while preserving job and recording history.</summary>
[DbContext(typeof(NixDbContext))]
[Migration("20261009200000_RetireSpeechJobs")]
public sealed class RetireSpeechJobs : Migration
{
    /// <inheritdoc />
    protected override void Up(MigrationBuilder migrationBuilder) => migrationBuilder.Sql("""
        UPDATE worker_job
           SET status = 'cancelled',
               cancellation_requested = true,
               error_code = 'job_cancelled',
               error_detail = 'Speech transcription has been retired.',
               lease_owner = NULL,
               lease_until = NULL,
               completed_at = CURRENT_TIMESTAMP,
               updated_at = CURRENT_TIMESTAMP
         WHERE kind = 'transcribe.audio'
           AND status IN ('queued', 'running');

        UPDATE worker_outbox_event
           SET processed_at = CURRENT_TIMESTAMP,
               lease_owner = NULL,
               lease_until = NULL,
               last_error = 'Speech transcription has been retired.'
         WHERE kind = 'worker.command'
           AND payload ->> 'kind' = 'transcribe.audio'
           AND processed_at IS NULL;
        """);

    /// <inheritdoc />
    protected override void Down(MigrationBuilder migrationBuilder)
    {
        // Rolling back the feature must not resume cancelled executions or republish their commands.
    }
}
