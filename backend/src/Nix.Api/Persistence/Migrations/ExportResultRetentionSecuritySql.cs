namespace Nix.Persistence.Migrations;

/// <summary>Durably schedules deletion of completed export objects after their download window.</summary>
public static class ExportResultRetentionSecuritySql
{
    private const string ApplicationRole = "nix_app";

    /// <summary>Creates the narrow cross-tenant export-retention function used by result ingestion.</summary>
    public static void Apply(Action<string> emit)
    {
        ArgumentNullException.ThrowIfNull(emit);
        emit($$"""
            CREATE OR REPLACE FUNCTION nix_schedule_export_result_cleanup(p_job_id uuid)
            RETURNS boolean
            LANGUAGE plpgsql
            VOLATILE
            SECURITY DEFINER
            SET search_path = pg_catalog, public
            AS $function$
            DECLARE
                source worker_job%ROWTYPE;
                cleanup_job_id uuid;
                cleanup_key text;
                cleanup_at timestamptz;
                extension text;
                attempt_id text;
            BEGIN
                SELECT job.*
                  INTO source
                  FROM worker_job job
                 WHERE job.job_id = p_job_id
                   AND job.status = 'completed'
                   AND job.kind LIKE 'export.%'
                   AND job.actor_id IS NOT NULL
                   AND job.workspace_id IS NOT NULL
                   AND job.completed_at IS NOT NULL;

                IF NOT FOUND THEN
                    RETURN false;
                END IF;

                extension := source.payload ->> 'extension';
                IF extension IS NULL OR extension !~ '^[a-z0-9]{1,16}$' THEN
                    RETURN false;
                END IF;

                attempt_id := source.result ->> 'attemptId';
                IF attempt_id IS NULL
                   OR attempt_id !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
                    RETURN false;
                END IF;

                cleanup_key := 'exports/results/' || source.tenant_id::text || '/'
                    || source.job_id::text || '/' || attempt_id || '.' || extension;
                IF source.result ->> 'objectKey' IS DISTINCT FROM cleanup_key THEN
                    RETURN false;
                END IF;
                cleanup_at := source.completed_at + interval '24 hours';

                INSERT INTO worker_job (
                    job_id,
                    tenant_id,
                    workspace_id,
                    actor_id,
                    kind,
                    idempotency_key,
                    payload,
                    status,
                    attempts,
                    cancellation_requested,
                    created_at,
                    updated_at)
                VALUES (
                    gen_random_uuid(),
                    source.tenant_id,
                    source.workspace_id,
                    source.actor_id,
                    'object.cleanup',
                    'object.cleanup:export:' || source.job_id::text,
                    jsonb_build_object(
                        'ownerKind', 'export',
                        'ownerId', source.job_id,
                        'notBefore', cleanup_at,
                        'objectKeys', jsonb_build_array(cleanup_key)),
                    'queued',
                    0,
                    false,
                    clock_timestamp(),
                    clock_timestamp())
                ON CONFLICT (tenant_id, actor_id, idempotency_key) DO NOTHING
                RETURNING job_id INTO cleanup_job_id;

                IF cleanup_job_id IS NULL THEN
                    RETURN EXISTS (
                        SELECT 1
                          FROM worker_job existing
                         WHERE existing.tenant_id = source.tenant_id
                           AND existing.actor_id = source.actor_id
                           AND existing.idempotency_key = 'object.cleanup:export:' || source.job_id::text
                           AND existing.kind = 'object.cleanup'
                           AND existing.payload ->> 'ownerKind' = 'export'
                           AND existing.payload ->> 'ownerId' = source.job_id::text
                           AND existing.payload -> 'objectKeys' = jsonb_build_array(cleanup_key));
                END IF;

                INSERT INTO worker_outbox_event (
                    event_id,
                    tenant_id,
                    workspace_id,
                    item_id,
                    kind,
                    aggregate_version,
                    payload,
                    available_at,
                    attempts,
                    lease_owner,
                    lease_until,
                    processed_at,
                    last_error)
                VALUES (
                    gen_random_uuid(),
                    source.tenant_id,
                    source.workspace_id,
                    NULL,
                    'worker.command',
                    NULL,
                    jsonb_build_object('jobId', cleanup_job_id, 'kind', 'object.cleanup'),
                    cleanup_at,
                    0,
                    NULL,
                    NULL,
                    NULL,
                    NULL);
                RETURN true;
            END
            $function$;

            REVOKE ALL ON FUNCTION nix_schedule_export_result_cleanup(uuid) FROM PUBLIC;
            GRANT EXECUTE ON FUNCTION nix_schedule_export_result_cleanup(uuid) TO {{ApplicationRole}};
            """);
    }

    /// <summary>Removes the export-retention function.</summary>
    public static void Revert(Action<string> emit)
    {
        ArgumentNullException.ThrowIfNull(emit);
        emit("DROP FUNCTION IF EXISTS nix_schedule_export_result_cleanup(uuid);");
    }
}
