namespace Nix.Persistence.Migrations;

/// <summary>Bounded retry completion for globally dispatched worker jobs.</summary>
public static class WorkerRetrySecuritySql
{
    private const string ApplicationRole = "nix_app";

    /// <summary>Creates the lease-owner checked finish function.</summary>
    public static void Apply(Action<string> emit)
    {
        ArgumentNullException.ThrowIfNull(emit);
        emit($$"""
            CREATE FUNCTION nix_finish_worker_job(
                p_job_id uuid,
                p_owner text,
                p_succeeded boolean,
                p_retryable boolean,
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
                   SET status = CASE
                           WHEN p_succeeded THEN 'completed'
                           WHEN p_retryable AND attempts < 5 THEN 'running'
                           ELSE 'failed'
                       END,
                       result = CASE WHEN p_succeeded THEN p_result ELSE NULL END,
                       error_code = CASE WHEN p_succeeded THEN NULL ELSE left(p_error_code, 64) END,
                       error_detail = CASE WHEN p_succeeded THEN NULL ELSE left(p_error_detail, 2000) END,
                       lease_owner = NULL,
                       lease_until = CASE
                           WHEN NOT p_succeeded AND p_retryable AND attempts < 5
                               THEN clock_timestamp() + make_interval(secs => LEAST(GREATEST(attempts * 5, 5), 300))
                           ELSE NULL
                       END,
                       completed_at = CASE
                           WHEN NOT p_succeeded AND p_retryable AND attempts < 5 THEN NULL
                           ELSE clock_timestamp()
                       END,
                       updated_at = clock_timestamp()
                 WHERE job_id = p_job_id
                   AND status = 'running'
                   AND lease_owner = p_owner
                   AND lease_until >= clock_timestamp()
                RETURNING true
            $function$;

            REVOKE ALL ON FUNCTION nix_finish_worker_job(uuid, text, boolean, boolean, jsonb, text, text) FROM PUBLIC;
            GRANT EXECUTE ON FUNCTION nix_finish_worker_job(uuid, text, boolean, boolean, jsonb, text, text) TO {{ApplicationRole}};
            """);
    }

    /// <summary>Drops the retry completion function.</summary>
    public static void Revert(Action<string> emit)
    {
        ArgumentNullException.ThrowIfNull(emit);
        emit("DROP FUNCTION IF EXISTS nix_finish_worker_job(uuid, text, boolean, boolean, jsonb, text, text);");
    }
}
