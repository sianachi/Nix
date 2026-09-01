namespace Nix.Persistence.Migrations;

/// <summary>Creates the exact, lease-bound authorization function used by worker execution requests.</summary>
public static class WorkerExecutionSecuritySql
{
    private const string ApplicationRole = "nix_app";

    /// <summary>Creates the function without granting workers any direct database access.</summary>
    public static void Apply(Action<string> emit)
    {
        ApplyCore(emit, allowSystemCleanup: false);
    }

    /// <summary>Allows byte cleanup to outlive suspension of the principal that began an upload.</summary>
    public static void ApplyAllowingSystemCleanup(Action<string> emit)
    {
        ApplyCore(emit, allowSystemCleanup: true);
    }

    private static void ApplyCore(Action<string> emit, bool allowSystemCleanup)
    {
        ArgumentNullException.ThrowIfNull(emit);
        var actorPredicate = allowSystemCleanup
            ? "(actor.status = 'active' OR job.kind = 'object.cleanup')"
            : "actor.status = 'active'";
        emit($$"""
            CREATE OR REPLACE FUNCTION nix_authorize_worker_execution(
                p_job_id uuid,
                p_owner text)
            RETURNS TABLE (
                tenant_id uuid,
                workspace_id uuid,
                actor_id uuid,
                kind text)
            LANGUAGE sql
            VOLATILE
            SECURITY DEFINER
            SET search_path = pg_catalog, public
            AS $function$
                SELECT job.tenant_id,
                       job.workspace_id,
                       job.actor_id,
                       job.kind::text
                  FROM worker_job job
                  JOIN principal actor
                    ON actor.tenant_id = job.tenant_id
                   AND actor.principal_id = job.actor_id
                 WHERE job.job_id = p_job_id
                   AND job.status = 'running'
                   AND job.cancellation_requested = false
                   AND job.lease_owner = p_owner
                   AND job.lease_until >= clock_timestamp()
                   AND {{actorPredicate}}
                   AND p_owner IS NOT NULL
                   AND length(p_owner) BETWEEN 1 AND 128
            $function$;

            REVOKE ALL ON FUNCTION nix_authorize_worker_execution(uuid, text) FROM PUBLIC;
            GRANT EXECUTE ON FUNCTION nix_authorize_worker_execution(uuid, text) TO {{ApplicationRole}};
            """);
    }

    /// <summary>Removes the execution authorization function.</summary>
    public static void Revert(Action<string> emit)
    {
        ArgumentNullException.ThrowIfNull(emit);
        emit("DROP FUNCTION IF EXISTS nix_authorize_worker_execution(uuid, text);");
    }
}
