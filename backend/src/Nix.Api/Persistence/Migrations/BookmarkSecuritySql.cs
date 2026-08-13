namespace Nix.Persistence.Migrations;

/// <summary>
/// The hand-written half of the bookmark migration: the isolation policy on <c>bookmark</c>, the
/// sequence its ordering comes from, and the bound on how large one shelf may grow.
/// </summary>
/// <remarks>
/// Outside <c>Migrations/Generated</c> because that folder is rewritten wholesale by the next
/// scaffold, and this SQL is the only thing that isolates the table. Frozen to its migration: a
/// later phase writes its own equivalent rather than editing this, because a migration is a record
/// of what was applied on a particular day.
/// </remarks>
public static class BookmarkSecuritySql
{
    /// <summary>The runtime role Core connects as.</summary>
    private const string ApplicationRole = "nix_app";

    /// <summary>
    /// Emits every statement, in dependency order.
    /// </summary>
    /// <param name="emit">Sends one statement batch to the migration.</param>
    public static void Apply(Action<string> emit)
    {
        ArgumentNullException.ThrowIfNull(emit);

        ProtectBookmarks(emit);
        GrantBookmarks(emit);
        BoundShelfSize(emit);
    }

    /// <summary>
    /// Puts the tenant isolation policy on <c>bookmark</c>.
    /// </summary>
    /// <remarks>
    /// <para>
    /// The same shape as every other tenant-scoped table: <c>USING</c> and <c>WITH CHECK</c> both
    /// present, <c>current_setting(..., true)</c> so an unscoped session sees nothing rather than
    /// raising, <c>FORCE</c> so the table owner is subject to it too.
    /// </para>
    /// <para>
    /// <b>Tenant isolation is the boundary this policy draws, and it is not the only one that
    /// matters.</b> One principal must not read another's shelf, and that is enforced in the
    /// statement rather than here - the queries take the acting principal from the session context
    /// and never accept one as input, the same way <c>GET /api/v1/me</c> does. A policy could carry
    /// it too, and the reason it does not is that <c>nix.principal_id</c> would then be load-bearing
    /// for correctness on a table where the application already has to name the principal to write
    /// a row at all. Two controls that must agree, where one of them is invisible at the call site,
    /// is how they drift.
    /// </para>
    /// </remarks>
    private static void ProtectBookmarks(Action<string> emit) =>
        emit("""
            ALTER TABLE bookmark ENABLE ROW LEVEL SECURITY;
            ALTER TABLE bookmark FORCE ROW LEVEL SECURITY;

            DROP POLICY IF EXISTS bookmark_tenant_isolation ON bookmark;
            CREATE POLICY bookmark_tenant_isolation ON bookmark
                USING (tenant_id = NULLIF(current_setting('nix.tenant_id', true), '')::uuid)
                WITH CHECK (tenant_id = NULLIF(current_setting('nix.tenant_id', true), '')::uuid);
            """);

    /// <summary>
    /// Narrows the runtime role's privileges to what it is expected to hold.
    /// </summary>
    /// <remarks>
    /// The database seed's <c>ALTER DEFAULT PRIVILEGES</c> makes grants fail <i>open</i>, so a new
    /// table arrives with full DML whether or not that was intended. Stating it is what turns the
    /// default into a decision, and <c>NixTables.ExpectedApplicationPrivileges</c> asserts this
    /// exact set against the live catalogue.
    /// </remarks>
    private static void GrantBookmarks(Action<string> emit) =>
        emit($"""
            REVOKE ALL ON bookmark FROM PUBLIC;
            GRANT SELECT, INSERT, UPDATE, DELETE ON bookmark TO {ApplicationRole};
            GRANT USAGE, SELECT ON SEQUENCE bookmark_seq_seq TO {ApplicationRole};
            """);

    /// <summary>
    /// Bounds how many items one principal may keep.
    /// </summary>
    /// <remarks>
    /// <para>
    /// Five hundred, enforced by a trigger rather than a constraint, because the thing being bounded
    /// is a count across rows and a <c>CHECK</c> cannot see its siblings. A shelf is something a
    /// person curates by hand; past a few hundred it has stopped being one and the list read would
    /// start returning a page nobody asked to page through.
    /// </para>
    /// <para>
    /// It also stops the obvious abuse: a client looping over every item in a workspace turns an
    /// unbounded write into an unbounded read for everybody who lists afterwards.
    /// </para>
    /// </remarks>
    private static void BoundShelfSize(Action<string> emit) =>
        emit("""
            CREATE OR REPLACE FUNCTION nix_bound_bookmark_shelf() RETURNS trigger
            LANGUAGE plpgsql AS $$
            DECLARE
                kept bigint;
            BEGIN
                SELECT count(*) INTO kept
                  FROM bookmark
                 WHERE tenant_id = NEW.tenant_id
                   AND principal_id = NEW.principal_id;

                IF kept > 500 THEN
                    RAISE EXCEPTION 'bookmark shelf is full'
                        USING ERRCODE = 'check_violation';
                END IF;

                RETURN NULL;
            END;
            $$;

            DROP TRIGGER IF EXISTS bookmark_shelf_bounded ON bookmark;
            CREATE CONSTRAINT TRIGGER bookmark_shelf_bounded
                AFTER INSERT ON bookmark
                DEFERRABLE INITIALLY IMMEDIATE
                FOR EACH ROW
                EXECUTE FUNCTION nix_bound_bookmark_shelf();
            """);
}
