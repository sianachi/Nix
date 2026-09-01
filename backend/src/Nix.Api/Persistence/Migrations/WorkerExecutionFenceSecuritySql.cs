namespace Nix.Persistence.Migrations;

/// <summary>Creates the transaction-scoped worker lease fence used by Collaboration body writes.</summary>
public static class WorkerExecutionFenceSecuritySql
{
    private const string ApplicationRole = "nix_app";
    private const string CollaborationRole = "nix_collab";

    /// <summary>
    /// Creates a narrow security-definer function that validates and locks one live worker job.
    /// </summary>
    public static void Apply(Action<string> emit)
    {
        ArgumentNullException.ThrowIfNull(emit);
        emit($$"""
            CREATE OR REPLACE FUNCTION nix_fence_worker_execution(
                p_job_id uuid,
                p_owner text,
                p_expected_kind text,
                p_tenant_id uuid,
                p_workspace_id uuid,
                p_actor_id uuid)
            RETURNS boolean
            LANGUAGE plpgsql
            VOLATILE
            SECURITY DEFINER
            SET search_path = pg_catalog, public
            AS $function$
            BEGIN
                PERFORM 1
                  FROM worker_job job
                  JOIN principal actor
                    ON actor.tenant_id = job.tenant_id
                   AND actor.principal_id = job.actor_id
                 WHERE job.job_id = p_job_id
                   AND job.tenant_id = p_tenant_id
                   AND job.workspace_id IS NOT DISTINCT FROM p_workspace_id
                   AND job.actor_id = p_actor_id
                   AND job.kind::text = p_expected_kind
                   AND job.status = 'running'
                   AND job.cancellation_requested = false
                   AND job.lease_owner = p_owner
                   AND job.lease_until >= clock_timestamp()
                   AND (actor.status = 'active' OR job.kind = 'object.cleanup')
                   AND p_owner IS NOT NULL
                   AND length(p_owner) BETWEEN 1 AND 128
                   AND p_expected_kind ~ '^[a-z][a-z0-9.]{0,79}$'
                 FOR UPDATE OF job;

                RETURN FOUND;
            END;
            $function$;

            REVOKE ALL ON FUNCTION nix_fence_worker_execution(uuid, text, text, uuid, uuid, uuid) FROM PUBLIC;
            GRANT EXECUTE ON FUNCTION nix_fence_worker_execution(uuid, text, text, uuid, uuid, uuid) TO {{ApplicationRole}};
            GRANT EXECUTE ON FUNCTION nix_fence_worker_execution(uuid, text, text, uuid, uuid, uuid) TO {{CollaborationRole}};
            """);
    }

    /// <summary>Removes the transaction-scoped worker lease fence.</summary>
    public static void Revert(Action<string> emit)
    {
        ArgumentNullException.ThrowIfNull(emit);
        emit("DROP FUNCTION IF EXISTS nix_fence_worker_execution(uuid, text, text, uuid, uuid, uuid);");
    }
}
