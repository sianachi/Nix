namespace Nix.Persistence.Migrations;

/// <summary>Narrow cross-tenant queue functions for service-authenticated worker dispatch.</summary>
public static class WorkerDispatchSecuritySql
{
    private const string ApplicationRole = "nix_app";

    /// <summary>Creates queue functions that reveal only leased work and verify lease ownership.</summary>
    public static void Apply(Action<string> emit)
    {
        ArgumentNullException.ThrowIfNull(emit);
        emit($$"""
            CREATE FUNCTION nix_lease_worker_jobs(
                p_kind text,
                p_owner text,
                p_limit integer,
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
                   OR p_limit NOT BETWEEN 1 AND 100
                   OR p_lease_seconds NOT BETWEEN 5 AND 300 THEN
                    RAISE EXCEPTION 'invalid worker lease request';
                END IF;

                RETURN QUERY
                WITH candidates AS (
                    SELECT queued.job_id
                      FROM worker_job queued
                     WHERE (p_kind IS NULL OR queued.kind = p_kind)
                       AND queued.cancellation_requested = false
                       AND (queued.status = 'queued'
                            OR (queued.status = 'running' AND queued.lease_until < clock_timestamp()))
                     ORDER BY queued.created_at, queued.job_id
                     FOR UPDATE SKIP LOCKED
                     LIMIT p_limit
                )
                UPDATE worker_job leased
                   SET status = 'running',
                       attempts = leased.attempts + 1,
                       lease_owner = p_owner,
                       lease_until = clock_timestamp() + make_interval(secs => p_lease_seconds),
                       started_at = COALESCE(leased.started_at, clock_timestamp()),
                       updated_at = clock_timestamp()
                  FROM candidates
                 WHERE leased.job_id = candidates.job_id
                RETURNING leased.job_id,
                          leased.tenant_id,
                          leased.workspace_id,
                          leased.actor_id,
                          leased.kind::text,
                          leased.payload,
                          leased.attempts,
                          leased.cancellation_requested;
            END
            $function$;

            CREATE FUNCTION nix_complete_worker_job(
                p_job_id uuid,
                p_owner text,
                p_succeeded boolean,
                p_result jsonb,
                p_error_code text,
                p_error_detail text)
            RETURNS boolean
            LANGUAGE sql
            VOLATILE
            SECURITY DEFINER
            SET search_path = pg_catalog, public
            AS $function$
                UPDATE worker_job
                   SET status = CASE WHEN p_succeeded THEN 'completed' ELSE 'failed' END,
                       result = p_result,
                       error_code = left(p_error_code, 64),
                       error_detail = left(p_error_detail, 2000),
                       lease_owner = NULL,
                       lease_until = NULL,
                       completed_at = clock_timestamp(),
                       updated_at = clock_timestamp()
                 WHERE job_id = p_job_id
                   AND status = 'running'
                   AND lease_owner = p_owner
                   AND lease_until >= clock_timestamp()
                RETURNING true
            $function$;

            CREATE FUNCTION nix_lease_worker_outbox(
                p_kind text,
                p_owner text,
                p_limit integer,
                p_lease_seconds integer)
            RETURNS TABLE (
                event_id uuid,
                tenant_id uuid,
                workspace_id uuid,
                item_id uuid,
                kind text,
                payload jsonb,
                attempts integer,
                available_at timestamptz)
            LANGUAGE plpgsql
            VOLATILE
            SECURITY DEFINER
            SET search_path = pg_catalog, public
            AS $function$
            BEGIN
                IF p_owner IS NULL OR length(p_owner) NOT BETWEEN 1 AND 128
                   OR p_limit NOT BETWEEN 1 AND 100
                   OR p_lease_seconds NOT BETWEEN 5 AND 300 THEN
                    RAISE EXCEPTION 'invalid worker outbox lease request';
                END IF;

                RETURN QUERY
                WITH candidates AS (
                    SELECT queued.event_id
                      FROM worker_outbox_event queued
                     WHERE (p_kind IS NULL OR queued.kind = p_kind)
                       AND queued.processed_at IS NULL
                       AND queued.available_at <= clock_timestamp()
                       AND (queued.lease_until IS NULL OR queued.lease_until < clock_timestamp())
                     ORDER BY queued.available_at, queued.event_id
                     FOR UPDATE SKIP LOCKED
                     LIMIT p_limit
                )
                UPDATE worker_outbox_event leased
                   SET attempts = leased.attempts + 1,
                       lease_owner = p_owner,
                       lease_until = clock_timestamp() + make_interval(secs => p_lease_seconds)
                  FROM candidates
                 WHERE leased.event_id = candidates.event_id
                RETURNING leased.event_id,
                          leased.tenant_id,
                          leased.workspace_id,
                          leased.item_id,
                          leased.kind::text,
                          leased.payload,
                          leased.attempts,
                          leased.available_at;
            END
            $function$;

            CREATE FUNCTION nix_finish_worker_outbox(
                p_event_id uuid,
                p_owner text,
                p_succeeded boolean,
                p_error text)
            RETURNS boolean
            LANGUAGE sql
            VOLATILE
            SECURITY DEFINER
            SET search_path = pg_catalog, public
            AS $function$
                UPDATE worker_outbox_event
                   SET processed_at = CASE WHEN p_succeeded THEN clock_timestamp() ELSE NULL END,
                       last_error = CASE WHEN p_succeeded THEN NULL ELSE left(p_error, 2000) END,
                       available_at = CASE
                           WHEN p_succeeded THEN available_at
                           ELSE clock_timestamp() + make_interval(secs => LEAST(GREATEST(attempts * 5, 5), 300))
                       END,
                       lease_owner = NULL,
                       lease_until = NULL
                 WHERE event_id = p_event_id
                   AND lease_owner = p_owner
                   AND lease_until >= clock_timestamp()
                RETURNING true
            $function$;

            REVOKE ALL ON FUNCTION nix_lease_worker_jobs(text, text, integer, integer) FROM PUBLIC;
            REVOKE ALL ON FUNCTION nix_complete_worker_job(uuid, text, boolean, jsonb, text, text) FROM PUBLIC;
            REVOKE ALL ON FUNCTION nix_lease_worker_outbox(text, text, integer, integer) FROM PUBLIC;
            REVOKE ALL ON FUNCTION nix_finish_worker_outbox(uuid, text, boolean, text) FROM PUBLIC;
            GRANT EXECUTE ON FUNCTION nix_lease_worker_jobs(text, text, integer, integer) TO {{ApplicationRole}};
            GRANT EXECUTE ON FUNCTION nix_complete_worker_job(uuid, text, boolean, jsonb, text, text) TO {{ApplicationRole}};
            GRANT EXECUTE ON FUNCTION nix_lease_worker_outbox(text, text, integer, integer) TO {{ApplicationRole}};
            GRANT EXECUTE ON FUNCTION nix_finish_worker_outbox(uuid, text, boolean, text) TO {{ApplicationRole}};
            """);
    }

    /// <summary>Drops dispatch functions in reverse dependency order.</summary>
    public static void Revert(Action<string> emit)
    {
        ArgumentNullException.ThrowIfNull(emit);
        emit("""
            DROP FUNCTION IF EXISTS nix_finish_worker_outbox(uuid, text, boolean, text);
            DROP FUNCTION IF EXISTS nix_lease_worker_outbox(text, text, integer, integer);
            DROP FUNCTION IF EXISTS nix_complete_worker_job(uuid, text, boolean, jsonb, text, text);
            DROP FUNCTION IF EXISTS nix_lease_worker_jobs(text, text, integer, integer);
            """);
    }
}
