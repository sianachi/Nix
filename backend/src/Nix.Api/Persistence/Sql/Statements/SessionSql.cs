namespace Nix.Persistence.Sql.Statements;

/// <summary>
/// Statements about the current database session.
/// </summary>
/// <remarks>
/// <para>
/// This folder is where hand-written SQL lives: one static class per area, each statement a
/// <c>const string</c>, executed through <see cref="NixSqlExecutor"/>. The tenancy, tree, and
/// authorization goals add <c>ClosureSql</c>, <c>PermissionSql</c>, and <c>SearchSql</c>
/// alongside this file.
/// </para>
/// <para>
/// Rules for anything added here: values are bound as parameters and never interpolated; each
/// statement carries a comment naming the indexes its plan depends on; and a new statement over
/// <c>item_closure</c>, <c>acl_entry</c>, or <c>item_search</c> arrives with <c>EXPLAIN</c>
/// output attached to the pull request.
/// </para>
/// </remarks>
public static class SessionSql
{
    /// <summary>
    /// Reads back the three session settings the row-level security policies consume.
    /// </summary>
    /// <remarks>
    /// <para>
    /// The second argument to <c>current_setting</c> is <c>missing_ok</c>: with it, an unset
    /// custom setting yields NULL rather than raising. That distinction is the point of this
    /// statement - it can tell "no tenant established" apart from "some tenant established", which
    /// is exactly what a leak test needs to observe.
    /// </para>
    /// <para>
    /// The empty string is folded to NULL because that is how the workspace setting encodes
    /// "tenant-wide, no workspace in scope"; policies must read it the same way.
    /// </para>
    /// <para>
    /// No index dependency: catalogue and GUC lookups only.
    /// </para>
    /// </remarks>
    public const string CurrentSessionContext = """
        SELECT NULLIF(current_setting('nix.tenant_id', true), '')    AS tenant_id,
               NULLIF(current_setting('nix.workspace_id', true), '') AS workspace_id,
               NULLIF(current_setting('nix.principal_id', true), '') AS principal_id
        """;

    /// <summary>
    /// Returns the tenant setting alone, unfolded.
    /// </summary>
    /// <remarks>
    /// Unfolded because the caller that matters is a leak check, and a leak check has to be able
    /// to distinguish "unset" from "set to the empty string".
    /// </remarks>
    public const string CurrentTenantSetting = "SELECT current_setting('nix.tenant_id', true)";

    /// <summary>
    /// Returns the process id of the backend serving this connection.
    /// </summary>
    /// <remarks>
    /// Identifies the physical connection behind a pooled lease. The pool-leak proof uses it to
    /// establish that two units of work really did land on the same backend, rather than assuming
    /// it from the pool configuration.
    /// </remarks>
    public const string BackendProcessId = "SELECT pg_backend_pid()";
}
