namespace Nix.Persistence.Migrations;

/// <summary>
/// Hand-written security DDL pinning <c>pg_temp</c> last in the search path of every
/// <c>SECURITY DEFINER</c> function in <c>public</c>.
/// </summary>
/// <remarks>
/// <para>
/// When <c>pg_temp</c> is absent from a function's <c>search_path</c>, Postgres searches the
/// session's temporary schema first for relations and types. A caller holding <c>TEMPORARY</c>
/// on the database could then create a temporary table shadowing one the function names without
/// a schema, attach a trigger to it, and have that trigger run with the owner's privileges.
/// Listing <c>pg_temp</c> explicitly and last moves it behind <c>public</c>.
/// </para>
/// <para>
/// Earlier migrations set <c>pg_catalog, public</c> on many definer functions. Their SQL is
/// frozen to the migrations that shipped it, so this sweep corrects the live functions instead,
/// and <c>DatabaseRoleTests</c> keeps every future definer function to the same rule. A future
/// <c>CREATE OR REPLACE</c> must write <c>SET search_path = pg_catalog, public, pg_temp</c>
/// itself rather than copy an older helper's clause.
/// </para>
/// </remarks>
internal static class SecurityDefinerSearchPathSecuritySql
{
    /// <summary>The search path every definer function is given.</summary>
    internal const string SafeSearchPath = "pg_catalog, public, pg_temp";

    /// <summary>Emits every statement.</summary>
    /// <param name="emit">Sends one statement batch to the migration.</param>
    /// <remarks>
    /// <c>ALTER FUNCTION</c> requires ownership. Every definer function is created by the
    /// migrator, so an unowned one fails the migration loudly rather than being skipped.
    /// </remarks>
    internal static void Apply(Action<string> emit)
    {
        ArgumentNullException.ThrowIfNull(emit);

        emit($$"""
            DO $harden$
            DECLARE
                target regprocedure;
            BEGIN
                FOR target IN
                    SELECT p.oid::regprocedure
                      FROM pg_catalog.pg_proc p
                      JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
                     WHERE n.nspname = 'public'
                       AND p.prosecdef
                       AND NOT EXISTS (
                           SELECT 1
                             FROM pg_catalog.unnest(p.proconfig) AS setting
                            WHERE setting ~ '^search_path=(.*,\s*)?"?pg_temp"?$')
                     ORDER BY p.oid
                LOOP
                    EXECUTE pg_catalog.format(
                        'ALTER FUNCTION %s SET search_path = {{SafeSearchPath}}',
                        target);
                END LOOP;
            END
            $harden$;
            """);
    }

    /// <summary>Deliberately leaves the hardened search paths in place.</summary>
    /// <param name="emit">Sends one statement batch to the migration.</param>
    /// <remarks>
    /// Reverting would restore a search path through which the runtime role could run code as
    /// the schema owner. Rolling the schema back past this migration keeps the safe setting.
    /// </remarks>
    internal static void Revert(Action<string> emit) => ArgumentNullException.ThrowIfNull(emit);
}
