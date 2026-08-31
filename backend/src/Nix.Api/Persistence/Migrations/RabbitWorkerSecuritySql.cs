namespace Nix.Persistence.Migrations;

/// <summary>Exact broker-command claiming and retry-safe result application.</summary>
public static class RabbitWorkerSecuritySql
{
    private const string ApplicationRole = "nix_app";

    /// <summary>Creates the narrow cross-tenant functions used by RabbitMQ dispatch.</summary>
    public static void Apply(Action<string> emit)
    {
        ArgumentNullException.ThrowIfNull(emit);
        emit($$"""
            CREATE FUNCTION nix_claim_worker_job(
                p_job_id uuid,
                p_owner text,
                p_lease_seconds integer)
            RETURNS TABLE (
                job_id uuid,
                tenant_id uuid,
                workspace_id uuid,
                actor_id uuid,
                kind text,
                payload jsonb,
                attempts integer,
                cancellation_requested boolean)
            LANGUAGE plpgsql
            VOLATILE
            SECURITY DEFINER
            SET search_path = pg_catalog, public
            AS $function$
            BEGIN
                IF p_owner IS NULL OR length(p_owner) NOT BETWEEN 1 AND 128
                   OR p_lease_seconds NOT BETWEEN 5 AND 300 THEN
                    RAISE EXCEPTION 'invalid worker claim request';
                END IF;

                RETURN QUERY
                UPDATE worker_job claimed
                   SET status = 'running',
                       attempts = claimed.attempts + 1,
                       lease_owner = p_owner,
                       lease_until = clock_timestamp() + make_interval(secs => p_lease_seconds),
                       started_at = COALESCE(claimed.started_at, clock_timestamp()),
                       updated_at = clock_timestamp()
                 WHERE claimed.job_id = p_job_id
                   AND claimed.cancellation_requested = false
                   AND claimed.attempts < 5
                   AND (claimed.status = 'queued'
                        OR (claimed.status = 'running'
                            AND claimed.lease_until <= clock_timestamp()))
                RETURNING claimed.job_id,
                          claimed.tenant_id,
                          claimed.workspace_id,
                          claimed.actor_id,
                          claimed.kind::text,
                          claimed.payload,
                          claimed.attempts,
                          claimed.cancellation_requested;
            END
            $function$;

            CREATE FUNCTION nix_renew_worker_job(
                p_job_id uuid,
                p_owner text,
                p_lease_seconds integer)
            RETURNS boolean
            LANGUAGE plpgsql
            VOLATILE
            SECURITY DEFINER
            SET search_path = pg_catalog, public
            AS $function$
            DECLARE
                renewed_successfully boolean;
            BEGIN
                IF p_owner IS NULL OR length(p_owner) NOT BETWEEN 1 AND 128
                   OR p_lease_seconds NOT BETWEEN 5 AND 300 THEN
                    RAISE EXCEPTION 'invalid worker renewal request';
                END IF;

                WITH renewed_rows AS (
                    UPDATE worker_job renewed
                       SET lease_until = clock_timestamp() + make_interval(secs => p_lease_seconds),
                           updated_at = clock_timestamp()
                     WHERE renewed.job_id = p_job_id
                       AND renewed.status = 'running'
                       AND renewed.lease_owner = p_owner
                       AND renewed.lease_until >= clock_timestamp()
                    RETURNING 1)
                SELECT EXISTS (SELECT 1 FROM renewed_rows) INTO renewed_successfully;
                RETURN renewed_successfully;
            END
            $function$;

            CREATE FUNCTION nix_worker_job_state(
                p_job_id uuid,
                p_owner text)
            RETURNS TABLE (
                status text,
                cancellation_requested boolean,
                lease_owned boolean,
                lease_until timestamptz)
            LANGUAGE sql
            VOLATILE
            SECURITY DEFINER
            SET search_path = pg_catalog, public
            AS $function$
                SELECT job.status::text,
                       job.cancellation_requested,
                       job.lease_owner = p_owner AND job.lease_until >= clock_timestamp(),
                       job.lease_until
                  FROM worker_job job
                 WHERE job.job_id = p_job_id
                   AND p_owner IS NOT NULL
                   AND length(p_owner) BETWEEN 1 AND 128
            $function$;

            CREATE OR REPLACE FUNCTION nix_finish_worker_job(
                p_job_id uuid,
                p_owner text,
                p_succeeded boolean,
                p_retryable boolean,
                p_result jsonb,
                p_error_code text,
                p_error_detail text)
            RETURNS boolean
            LANGUAGE plpgsql
            VOLATILE
            SECURITY DEFINER
            SET search_path = pg_catalog, public
            AS $function$
            DECLARE
                changed worker_job%ROWTYPE;
                retry_delay integer;
            BEGIN
                retry_delay := CASE
                    WHEN (SELECT attempts FROM worker_job WHERE job_id = p_job_id) <= 1 THEN 5
                    WHEN (SELECT attempts FROM worker_job WHERE job_id = p_job_id) = 2 THEN 30
                    WHEN (SELECT attempts FROM worker_job WHERE job_id = p_job_id) = 3 THEN 120
                    ELSE 300
                END;

                UPDATE worker_job job
                   SET status = CASE
                           WHEN p_succeeded THEN 'completed'
                           WHEN p_error_code = 'job_cancelled' THEN 'cancelled'
                           WHEN p_retryable AND job.attempts < 5 THEN 'running'
                           ELSE 'failed'
                       END,
                       result = CASE WHEN p_succeeded THEN p_result ELSE NULL END,
                       error_code = CASE WHEN p_succeeded THEN NULL ELSE left(p_error_code, 64) END,
                       error_detail = CASE WHEN p_succeeded THEN NULL ELSE left(p_error_detail, 2000) END,
                       lease_owner = NULL,
                       lease_until = CASE
                           WHEN NOT p_succeeded
                                AND p_error_code IS DISTINCT FROM 'job_cancelled'
                                AND p_retryable
                                AND job.attempts < 5
                               THEN clock_timestamp() + make_interval(secs => retry_delay)
                           ELSE NULL
                       END,
                       completed_at = CASE
                           WHEN NOT p_succeeded
                                AND p_error_code IS DISTINCT FROM 'job_cancelled'
                                AND p_retryable
                                AND job.attempts < 5 THEN NULL
                           ELSE clock_timestamp()
                       END,
                       updated_at = clock_timestamp()
                 WHERE job.job_id = p_job_id
                   AND job.status = 'running'
                   AND job.lease_owner = p_owner
                   AND job.lease_until >= clock_timestamp()
                RETURNING job.* INTO changed;

                IF NOT FOUND THEN
                    RETURN false;
                END IF;

                IF changed.status = 'running' THEN
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
                        changed.tenant_id,
                        changed.workspace_id,
                        NULL,
                        'worker.command',
                        NULL,
                        jsonb_build_object('jobId', changed.job_id, 'kind', changed.kind),
                        changed.lease_until,
                        0,
                        NULL,
                        NULL,
                        NULL,
                        NULL);
                END IF;

                RETURN true;
            END
            $function$;

            REVOKE ALL ON FUNCTION nix_claim_worker_job(uuid, text, integer) FROM PUBLIC;
            REVOKE ALL ON FUNCTION nix_renew_worker_job(uuid, text, integer) FROM PUBLIC;
            REVOKE ALL ON FUNCTION nix_worker_job_state(uuid, text) FROM PUBLIC;
            REVOKE ALL ON FUNCTION nix_finish_worker_job(uuid, text, boolean, boolean, jsonb, text, text) FROM PUBLIC;
            GRANT EXECUTE ON FUNCTION nix_claim_worker_job(uuid, text, integer) TO {{ApplicationRole}};
            GRANT EXECUTE ON FUNCTION nix_renew_worker_job(uuid, text, integer) TO {{ApplicationRole}};
            GRANT EXECUTE ON FUNCTION nix_worker_job_state(uuid, text) TO {{ApplicationRole}};
            GRANT EXECUTE ON FUNCTION nix_finish_worker_job(uuid, text, boolean, boolean, jsonb, text, text) TO {{ApplicationRole}};
            """);
    }

    /// <summary>Removes Rabbit dispatch functions before restoring the polling result function.</summary>
    public static void Revert(Action<string> emit)
    {
        ArgumentNullException.ThrowIfNull(emit);
        emit("""
            DROP FUNCTION IF EXISTS nix_worker_job_state(uuid, text);
            DROP FUNCTION IF EXISTS nix_renew_worker_job(uuid, text, integer);
            DROP FUNCTION IF EXISTS nix_claim_worker_job(uuid, text, integer);
            DROP FUNCTION IF EXISTS nix_finish_worker_job(uuid, text, boolean, boolean, jsonb, text, text);
            """);
    }
}
