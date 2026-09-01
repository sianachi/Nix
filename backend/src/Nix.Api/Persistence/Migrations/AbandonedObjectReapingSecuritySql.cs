namespace Nix.Persistence.Migrations;

/// <summary>Narrow cross-tenant discovery for expired upload and import cleanup.</summary>
public static class AbandonedObjectReapingSecuritySql
{
    private const string ApplicationRole = "nix_app";

    /// <summary>Creates the bounded discovery function used by Core's expiry reaper.</summary>
    public static void Apply(Action<string> emit)
    {
        ArgumentNullException.ThrowIfNull(emit);
        emit($$"""
            CREATE OR REPLACE FUNCTION nix_find_abandoned_object_operations(p_limit integer)
            RETURNS TABLE (
                owner_kind text,
                owner_id uuid,
                tenant_id uuid,
                workspace_id uuid,
                actor_id uuid,
                expires_at timestamptz)
            LANGUAGE plpgsql
            VOLATILE
            SECURITY DEFINER
            SET search_path = pg_catalog, public
            AS $function$
            BEGIN
                IF p_limit NOT BETWEEN 1 AND 100 THEN
                    RAISE EXCEPTION 'invalid abandoned-object operation limit';
                END IF;

                RETURN QUERY
                SELECT candidate.owner_kind,
                       candidate.owner_id,
                       candidate.tenant_id,
                       candidate.workspace_id,
                       candidate.actor_id,
                       candidate.expires_at
                  FROM (
                      SELECT 'document-import'::text AS owner_kind,
                             operation.import_id AS owner_id,
                             operation.tenant_id,
                             operation.workspace_id,
                             operation.actor_id,
                             operation.expires_at
                        FROM document_import operation
                       WHERE operation.expires_at <= clock_timestamp()
                         AND operation.status NOT IN ('completed', 'cancelled', 'failed')
                      UNION ALL
                      SELECT 'file-upload'::text AS owner_kind,
                             upload.upload_id AS owner_id,
                             upload.tenant_id,
                             upload.workspace_id,
                             upload.actor_id,
                             upload.expires_at
                        FROM file_upload upload
                       WHERE upload.purpose = 'file'
                         AND upload.expires_at <= clock_timestamp()
                         AND upload.status IN ('pending_upload', 'inspection_queued')
                  ) candidate
                 ORDER BY candidate.expires_at, candidate.owner_id
                 LIMIT p_limit;
            END
            $function$;

            REVOKE ALL ON FUNCTION nix_find_abandoned_object_operations(integer) FROM PUBLIC;
            GRANT EXECUTE ON FUNCTION nix_find_abandoned_object_operations(integer) TO {{ApplicationRole}};
            """);
    }

    /// <summary>Removes the bounded discovery function.</summary>
    public static void Revert(Action<string> emit)
    {
        ArgumentNullException.ThrowIfNull(emit);
        emit("DROP FUNCTION IF EXISTS nix_find_abandoned_object_operations(integer);");
    }
}
