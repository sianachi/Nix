namespace Nix.Persistence.Migrations;

/// <summary>
/// Hand-written DDL for site hostnames and first-publish approval (ADR-0063 M5): the
/// primary-hostname guard and the background hostname checker's one cross-tenant reader.
/// </summary>
/// <remarks>
/// Applied last by the <c>Sites</c> migration, after <see cref="SitesSecuritySql"/> and
/// <see cref="SitesHardeningSecuritySql"/>; reverted first. Frozen to that migration.
/// </remarks>
internal static class SitesHostingSecuritySql
{
    private const string ApplicationRole = "nix_app";

    /// <summary>Emits the cross-tenant reader, the primary-hostname guard and the checker's index.</summary>
    /// <param name="emit">Sends one statement batch to the migration.</param>
    internal static void Apply(Action<string> emit)
    {
        ArgumentNullException.ThrowIfNull(emit);
        GuardPrimaryHostname(emit);

        // The background checker reads custom hostnames least recently checked first.
        emit("""
            CREATE INDEX IF NOT EXISTS ix_site_hostname_check
                ON site_hostname (checked_at ASC NULLS FIRST, site_id, hostname)
                WHERE kind = 'custom';
            """);
        emit($"""
            CREATE OR REPLACE FUNCTION nix_site_hostname_checks(p_limit integer)
            RETURNS TABLE (
                tenant_id uuid,
                workspace_id uuid,
                site_id uuid,
                principal_id uuid,
                hostname text,
                created_at timestamptz,
                verified_at timestamptz,
                checked_at timestamptz,
                check_failures integer)
            LANGUAGE plpgsql
            STABLE
            SECURITY DEFINER
            SET search_path = pg_catalog, public, pg_temp
            AS $function$
            BEGIN
                IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 500 THEN
                    RAISE EXCEPTION 'nix_site_hostname_checks: invalid arguments';
                END IF;

                RETURN QUERY
                SELECT host.tenant_id,
                       owner.workspace_id,
                       host.site_id,
                       owner.created_by,
                       host.hostname::text,
                       host.created_at,
                       host.verified_at,
                       host.checked_at,
                       host.check_failures
                  FROM public.site_hostname host
                  JOIN public.site owner
                    ON owner.tenant_id = host.tenant_id
                   AND owner.id = host.site_id
                 WHERE host.kind = 'custom'
                 ORDER BY host.checked_at ASC NULLS FIRST, host.site_id, host.hostname
                 LIMIT p_limit;
            END
            $function$;

            REVOKE ALL ON FUNCTION nix_site_hostname_checks(integer) FROM PUBLIC;
            GRANT EXECUTE ON FUNCTION nix_site_hostname_checks(integer) TO {ApplicationRole};
            """);
    }

    /// <summary>Drops the reader.</summary>
    /// <param name="emit">Sends one statement batch to the migration.</param>
    internal static void Revert(Action<string> emit)
    {
        ArgumentNullException.ThrowIfNull(emit);
        // Deletes every 'hostnames' activation: the restored CHECK on site_activation.reason does not allow them.
        emit("""
            DROP FUNCTION IF EXISTS nix_site_hostname_checks(integer);
            DROP INDEX IF EXISTS ix_site_hostname_check;
            DROP TRIGGER IF EXISTS site_primary_hostname_own ON site;
            DROP FUNCTION IF EXISTS nix_site_primary_hostname_guard();
            DROP TRIGGER IF EXISTS site_hostname_clear_primary ON site_hostname;
            DROP FUNCTION IF EXISTS nix_site_hostname_clear_primary();
            DELETE FROM site_activation WHERE reason = 'hostnames';
            """);
    }

    /// <summary>
    /// <c>site.primary_hostname</c> must name one of the site's own hostnames, and is cleared when
    /// that hostname goes. Triggers rather than a foreign key: <c>site_hostname</c> already
    /// references <c>site</c>, and a key back would make the pair a cycle, as with
    /// <c>live_build_id</c>.
    /// </summary>
    private static void GuardPrimaryHostname(Action<string> emit) =>
        emit("""
            CREATE OR REPLACE FUNCTION nix_site_primary_hostname_guard()
            RETURNS trigger
            LANGUAGE plpgsql
            SET search_path = pg_catalog, public, pg_temp
            AS $function$
            BEGIN
                -- KEY SHARE holds the hostname row until commit, so a concurrent delete cannot slip past.
                IF NEW.primary_hostname IS NOT NULL AND NOT EXISTS (
                    SELECT 1
                      FROM public.site_hostname host
                     WHERE host.tenant_id = NEW.tenant_id
                       AND host.site_id = NEW.id
                       AND host.hostname = NEW.primary_hostname
                       FOR KEY SHARE) THEN
                    RAISE EXCEPTION 'site.primary_hostname must name a hostname of the same site'
                        USING ERRCODE = 'foreign_key_violation';
                END IF;
                RETURN NEW;
            END
            $function$;

            DROP TRIGGER IF EXISTS site_primary_hostname_own ON site;
            CREATE TRIGGER site_primary_hostname_own
                BEFORE INSERT OR UPDATE OF primary_hostname ON site
                FOR EACH ROW
                EXECUTE FUNCTION nix_site_primary_hostname_guard();

            CREATE OR REPLACE FUNCTION nix_site_hostname_clear_primary()
            RETURNS trigger
            LANGUAGE plpgsql
            SET search_path = pg_catalog, public, pg_temp
            AS $function$
            BEGIN
                UPDATE public.site
                   SET primary_hostname = NULL
                 WHERE tenant_id = OLD.tenant_id
                   AND id = OLD.site_id
                   AND primary_hostname = OLD.hostname;
                RETURN OLD;
            END
            $function$;

            DROP TRIGGER IF EXISTS site_hostname_clear_primary ON site_hostname;
            CREATE TRIGGER site_hostname_clear_primary
                AFTER DELETE ON site_hostname
                FOR EACH ROW
                EXECUTE FUNCTION nix_site_hostname_clear_primary();
            """);
}
