namespace Nix.Persistence.Migrations;

/// <summary>
/// Hand-written security DDL that tightens the sites tables after review (ADR-0063): the manifest
/// pages are immutable once the build leaves the queue, the application role may change only a
/// build's lifecycle columns, a site can only point at one of its own builds, and the republish
/// planner neither loses a change made during a build nor lets a failing site starve the others.
/// </summary>
/// <remarks>
/// Applied second by the <c>Sites</c> migration, after <see cref="SitesSecuritySql"/> and before
/// <see cref="SitesHostingSecuritySql"/>, and frozen to it; <see cref="SitesSecuritySql"/> stays as
/// it was and this file writes the replacements. <see cref="Revert"/> drops what this adds and re-applies the
/// original, which is idempotent.
/// </remarks>
internal static class SitesHardeningSecuritySql
{
    private const string ApplicationRole = "nix_app";

    /// <summary>Emits every statement, in dependency order.</summary>
    /// <param name="emit">Sends one statement batch to the migration.</param>
    internal static void Apply(Action<string> emit)
    {
        ArgumentNullException.ThrowIfNull(emit);
        NarrowBuildUpdates(emit);
        PointOnlyAtOwnBuilds(emit);
        RefusePagesAfterSeal(emit);
        DiscoverRebuildCandidates(emit);
    }

    /// <summary>Undoes everything this adds and restores the original sites security DDL.</summary>
    /// <param name="emit">Sends one statement batch to the migration.</param>
    internal static void Revert(Action<string> emit)
    {
        ArgumentNullException.ThrowIfNull(emit);
        emit("""
            DROP FUNCTION IF EXISTS nix_site_rebuild_candidates(timestamptz, integer);
            DROP TRIGGER IF EXISTS site_build_page_queued_only ON site_build_page;
            DROP FUNCTION IF EXISTS nix_site_build_page_guard();
            DROP TRIGGER IF EXISTS site_live_build_own ON site;
            DROP FUNCTION IF EXISTS nix_site_live_build_guard();
            """);
        SitesSecuritySql.Apply(emit);
    }

    /// <summary>
    /// A build's identity and manifest header are fixed at insert; only the columns its lifecycle
    /// moves (seal, activation, retirement) may change afterwards.
    /// </summary>
    private static void NarrowBuildUpdates(Action<string> emit) =>
        emit($"""
            REVOKE UPDATE ON site_build FROM {ApplicationRole};
            GRANT UPDATE (status, file_count, total_bytes, loss, build_index_sha256, purge_id, sealed_at, activated_at)
                ON site_build TO {ApplicationRole};
            """);

    /// <summary>
    /// The live build must be one of the site's own builds. A trigger rather than a foreign key:
    /// <c>site_build</c> already references <c>site</c>, and a key back would make the pair a cycle
    /// (which also defeats the integration harness's dependency-ordered reset). The trigger is
    /// stricter than the key would be, since it checks the site as well as the tenant.
    /// </summary>
    private static void PointOnlyAtOwnBuilds(Action<string> emit) =>
        emit("""
            CREATE OR REPLACE FUNCTION nix_site_live_build_guard()
            RETURNS trigger
            LANGUAGE plpgsql
            SET search_path = pg_catalog, public, pg_temp
            AS $function$
            BEGIN
                IF NEW.live_build_id IS NOT NULL AND NOT EXISTS (
                    SELECT 1
                      FROM public.site_build build
                     WHERE build.tenant_id = NEW.tenant_id
                       AND build.id = NEW.live_build_id
                       AND build.site_id = NEW.id) THEN
                    RAISE EXCEPTION 'site.live_build_id must name a build of the same site'
                        USING ERRCODE = 'foreign_key_violation';
                END IF;
                RETURN NEW;
            END
            $function$;

            DROP TRIGGER IF EXISTS site_live_build_own ON site;
            CREATE TRIGGER site_live_build_own
                BEFORE INSERT OR UPDATE OF live_build_id ON site
                FOR EACH ROW
                EXECUTE FUNCTION nix_site_live_build_guard();
            """);

    /// <summary>
    /// Refuses a manifest page unless its build is still queued, as <c>site_build_file</c> already
    /// does: the publish request writes the build and its pages together, and nothing after it may
    /// add a page to a build a worker has started or sealed.
    /// </summary>
    private static void RefusePagesAfterSeal(Action<string> emit) =>
        emit("""
            CREATE OR REPLACE FUNCTION nix_site_build_page_guard()
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
                    RAISE EXCEPTION 'site_build_page accepts rows only for a queued build'
                        USING ERRCODE = 'check_violation';
                END IF;
                RETURN NEW;
            END
            $function$;

            DROP TRIGGER IF EXISTS site_build_page_queued_only ON site_build_page;
            CREATE TRIGGER site_build_page_queued_only
                BEFORE INSERT ON site_build_page
                FOR EACH ROW
                EXECUTE FUNCTION nix_site_build_page_guard();
            """);

    /// <summary>
    /// The republish planner's cross-tenant read, replaced. Same contract as the original (SECURITY
    /// DEFINER, migrator-owned, pinned path with <c>pg_temp</c> last, identifiers and instants only),
    /// with three changes.
    /// </summary>
    /// <remarks>
    /// <para>
    /// <b>A site with a build in flight is not a candidate.</b> A change made while a build runs
    /// would otherwise be planned, fired, refused as "already under way" and never planned again;
    /// left out, it is planned when the build ends, against the new live build.
    /// </para>
    /// <para>
    /// <b>A new lock counts as a change.</b> The change instant is the later of the newest
    /// <c>last_modified_at</c> and the newest <c>item_lock.locked_at</c> in the subtree, so locking
    /// a page withdraws it on the next automatic build.
    /// </para>
    /// <para>
    /// <b>Failing sites back off.</b> <c>failures</c> counts automatic builds since the live one
    /// that did not go live; the next try waits the debounce doubled per failure, at most a day,
    /// after the last one. Ordering by <c>fire_at</c> then puts healthy sites first.
    /// </para>
    /// </remarks>
    private static void DiscoverRebuildCandidates(Action<string> emit) =>
        emit($"""
            DROP FUNCTION IF EXISTS nix_site_rebuild_candidates(timestamptz, integer);
            CREATE FUNCTION nix_site_rebuild_candidates(p_now timestamptz, p_limit integer)
            RETURNS TABLE (
                tenant_id uuid,
                workspace_id uuid,
                site_id uuid,
                principal_id uuid,
                fire_at timestamptz,
                changed_at timestamptz,
                failures integer)
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
                       GREATEST(
                           change.changed_at + make_interval(secs => candidate.debounce_seconds),
                           attempts.last_failed_at
                               + make_interval(secs => LEAST(candidate.debounce_seconds * power(2, LEAST(attempts.failed, 12)), 86400)),
                           p_now),
                       change.changed_at,
                       attempts.failed
                  FROM public.site candidate
                  JOIN public.site_build live
                    ON live.tenant_id = candidate.tenant_id
                   AND live.id = candidate.live_build_id
                 CROSS JOIN LATERAL (
                       SELECT GREATEST(
                                  (SELECT max(descendant.last_modified_at)
                                     FROM public.item_closure edge
                                     JOIN public.item descendant
                                       ON descendant.tenant_id = edge.tenant_id
                                      AND descendant.id = edge.descendant_id
                                    WHERE edge.tenant_id = candidate.tenant_id
                                      AND edge.ancestor_id = candidate.root_item_id),
                                  (SELECT max(held.locked_at)
                                     FROM public.item_closure edge
                                     JOIN public.item_lock held
                                       ON held.tenant_id = edge.tenant_id
                                      AND held.item_id = edge.descendant_id
                                    WHERE edge.tenant_id = candidate.tenant_id
                                      AND edge.ancestor_id = candidate.root_item_id)) AS changed_at
                   ) change
                 CROSS JOIN LATERAL (
                       SELECT count(*)::integer AS failed, max(attempt.created_at) AS last_failed_at
                         FROM public.site_build attempt
                        WHERE attempt.tenant_id = candidate.tenant_id
                          AND attempt.site_id = candidate.id
                          AND attempt.origin = 'auto'
                          AND attempt.created_at > live.created_at
                          AND attempt.status NOT IN ('live', 'superseded')
                   ) attempts
                 WHERE candidate.status = 'published'
                   AND candidate.republish_mode = 'auto'
                   AND candidate.auto_principal_id IS NOT NULL
                   AND change.changed_at > live.created_at
                   AND NOT EXISTS (
                       SELECT 1
                         FROM public.site_build open_build
                         JOIN public.worker_job job
                           ON job.tenant_id = open_build.tenant_id
                          AND job.job_id = open_build.job_id
                        WHERE open_build.tenant_id = candidate.tenant_id
                          AND open_build.site_id = candidate.id
                          AND open_build.status IN ('queued', 'sealed')
                          AND job.status IN ('queued', 'running'))
                 ORDER BY 5, candidate.id
                 LIMIT p_limit;
            END
            $function$;

            REVOKE ALL ON FUNCTION nix_site_rebuild_candidates(timestamptz, integer) FROM PUBLIC;
            GRANT EXECUTE ON FUNCTION nix_site_rebuild_candidates(timestamptz, integer) TO {ApplicationRole};
            """);
}
