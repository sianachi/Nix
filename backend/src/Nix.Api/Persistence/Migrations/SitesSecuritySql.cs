namespace Nix.Persistence.Migrations;

/// <summary>
/// Hand-written security DDL for the sites tables (ADR-0063): tenant isolation, the grant split,
/// the immutability of a build's manifest, and the one cross-tenant reader the automatic
/// republish planner needs.
/// </summary>
/// <remarks>
/// <para>
/// Applied first by the <c>Sites</c> migration, then <see cref="SitesHardeningSecuritySql"/> and
/// <see cref="SitesHostingSecuritySql"/>; reverted in the opposite order. Frozen to that migration:
/// a later phase writes its own equivalent rather than editing this one. The column bounds live in
/// the entity configurations as named CHECK constraints, so the generated migration carries them.
/// </para>
/// <para>
/// <b>Disclosure rests on three tables being immutable.</b> A build's pages and the files it may
/// copy are what a worker is told it can publish. The application role gets INSERT and SELECT on
/// them and nothing else, and a trigger refuses a file row once the build has left the queue, so
/// the sealed manifest cannot grow after the worker stopped asking.
/// </para>
/// </remarks>
internal static class SitesSecuritySql
{
    private const string ApplicationRole = "nix_app";
    private const string CollaborationRole = "nix_collab";

    private static readonly string[] Tables =
    [
        "site",
        "site_hostname",
        "site_exclusion",
        "site_dated_collection",
        "site_page",
        "site_redirect",
        "site_build",
        "site_build_page",
        "site_build_file",
        "site_build_object",
        "site_activation",
    ];

    /// <summary>Emits every statement, in dependency order.</summary>
    /// <param name="emit">Sends one statement batch to the migration.</param>
    internal static void Apply(Action<string> emit)
    {
        ArgumentNullException.ThrowIfNull(emit);

        foreach (var table in Tables)
        {
            Protect(emit, table);
        }

        SplitGrants(emit);
        RefuseFilesAfterSeal(emit);
        DiscoverRebuildCandidates(emit);
    }

    /// <summary>Undoes everything but the tables, which go with the generated Down.</summary>
    /// <param name="emit">Sends one statement batch to the migration.</param>
    internal static void Revert(Action<string> emit)
    {
        ArgumentNullException.ThrowIfNull(emit);

        emit("""
            DROP FUNCTION IF EXISTS nix_site_rebuild_candidates(timestamptz, integer);
            DROP TRIGGER IF EXISTS site_build_file_queued_only ON site_build_file;
            DROP FUNCTION IF EXISTS nix_site_build_file_guard();
            """);
    }

    /// <summary>
    /// Forced tenant isolation: <c>USING</c> and <c>WITH CHECK</c> both present, the setting read
    /// with <c>missing_ok</c> so an unscoped session sees nothing rather than raising.
    /// </summary>
    private static void Protect(Action<string> emit, string table) =>
        emit($"""
            ALTER TABLE {table} ENABLE ROW LEVEL SECURITY;
            ALTER TABLE {table} FORCE ROW LEVEL SECURITY;

            DROP POLICY IF EXISTS {table}_tenant_isolation ON {table};
            CREATE POLICY {table}_tenant_isolation ON {table}
                USING (tenant_id = NULLIF(current_setting('nix.tenant_id', true), '')::uuid)
                WITH CHECK (tenant_id = NULLIF(current_setting('nix.tenant_id', true), '')::uuid);
            """);

    /// <summary>
    /// Writes the intended privileges out per table. The database seed's default privileges grant
    /// a new table to the application role, so every table is revoked first and then narrowed.
    /// The collaboration service holds no grant on any of them.
    /// </summary>
    private static void SplitGrants(Action<string> emit)
    {
        foreach (var table in Tables)
        {
            emit($"""
                REVOKE ALL ON {table} FROM PUBLIC, {ApplicationRole}, {CollaborationRole};
                """);
        }

        emit($"""
            GRANT SELECT, INSERT, UPDATE, DELETE ON site, site_hostname, site_exclusion,
                site_dated_collection, site_page, site_redirect, site_activation TO {ApplicationRole};

            GRANT SELECT, INSERT, UPDATE ON site_build TO {ApplicationRole};
            GRANT SELECT, INSERT ON site_build_page TO {ApplicationRole};
            GRANT SELECT, INSERT ON site_build_file TO {ApplicationRole};
            GRANT SELECT, INSERT, DELETE ON site_build_object TO {ApplicationRole};
            """);
    }

    /// <summary>
    /// Refuses a file row unless its build is still queued. The route that records body images
    /// checks the same thing; the trigger is what holds when a request races the seal.
    /// </summary>
    private static void RefuseFilesAfterSeal(Action<string> emit) =>
        emit("""
            CREATE OR REPLACE FUNCTION nix_site_build_file_guard()
            RETURNS trigger
            LANGUAGE plpgsql
            SET search_path = pg_catalog, public, pg_temp
            AS $function$
            BEGIN
                IF NOT EXISTS (
                    SELECT 1
                      FROM public.site_build build
                     WHERE build.tenant_id = NEW.tenant_id
                       AND build.id = NEW.build_id
                       AND build.status = 'queued') THEN
                    RAISE EXCEPTION 'site_build_file accepts rows only for a queued build'
                        USING ERRCODE = 'check_violation';
                END IF;
                RETURN NEW;
            END
            $function$;

            DROP TRIGGER IF EXISTS site_build_file_queued_only ON site_build_file;
            CREATE TRIGGER site_build_file_queued_only
                BEFORE INSERT ON site_build_file
                FOR EACH ROW
                EXECUTE FUNCTION nix_site_build_file_guard();
            """);

    /// <summary>
    /// The automatic republish planner's only cross-tenant read: published sites in <c>auto</c>
    /// mode whose subtree changed after their live build was requested.
    /// </summary>
    /// <remarks>
    /// <para>
    /// SECURITY DEFINER, owned by the migrator (BYPASSRLS is what crosses FORCE ROW LEVEL
    /// SECURITY). It names <c>pg_temp</c> last in the pinned path and schema-qualifies every
    /// relation, so no temporary object can shadow one. It returns identifiers and an instant
    /// only, never a title or a body; the source re-verifies everything under the principal's own
    /// session when it fires.
    /// </para>
    /// <para>
    /// <c>fire_at</c> is the last change plus the site's debounce, raised to <c>p_now</c> so the
    /// planner never receives an instant in the past. The change instant is the maximum
    /// <c>last_modified_at</c> over the whole closure subtree, trashed items included: moving a
    /// page to the trash is an edit the public site should follow.
    /// </para>
    /// </remarks>
    private static void DiscoverRebuildCandidates(Action<string> emit) =>
        emit($"""
            CREATE OR REPLACE FUNCTION nix_site_rebuild_candidates(p_now timestamptz, p_limit integer)
            RETURNS TABLE (
                tenant_id uuid,
                workspace_id uuid,
                site_id uuid,
                principal_id uuid,
                fire_at timestamptz,
                changed_at timestamptz)
            LANGUAGE plpgsql
            STABLE
            SECURITY DEFINER
            SET search_path = pg_catalog, public, pg_temp
            AS $function$
            BEGIN
                IF p_now IS NULL OR p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 500 THEN
                    RAISE EXCEPTION 'nix_site_rebuild_candidates: invalid arguments';
                END IF;

                RETURN QUERY
                SELECT candidate.tenant_id,
                       candidate.workspace_id,
                       candidate.id,
                       candidate.auto_principal_id,
                       GREATEST(change.changed_at + make_interval(secs => candidate.debounce_seconds), p_now),
                       change.changed_at
                  FROM public.site candidate
                  JOIN public.site_build live
                    ON live.tenant_id = candidate.tenant_id
                   AND live.id = candidate.live_build_id
                 CROSS JOIN LATERAL (
                       SELECT max(descendant.last_modified_at) AS changed_at
                         FROM public.item_closure edge
                         JOIN public.item descendant
                           ON descendant.tenant_id = edge.tenant_id
                          AND descendant.id = edge.descendant_id
                        WHERE edge.tenant_id = candidate.tenant_id
                          AND edge.ancestor_id = candidate.root_item_id
                   ) change
                 WHERE candidate.status = 'published'
                   AND candidate.republish_mode = 'auto'
                   AND candidate.auto_principal_id IS NOT NULL
                   AND change.changed_at > live.created_at
                 ORDER BY 5, candidate.id
                 LIMIT p_limit;
            END
            $function$;

            REVOKE ALL ON FUNCTION nix_site_rebuild_candidates(timestamptz, integer) FROM PUBLIC;
            GRANT EXECUTE ON FUNCTION nix_site_rebuild_candidates(timestamptz, integer) TO {ApplicationRole};
            """);
}
