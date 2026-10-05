namespace Nix.Persistence.Migrations;

/// <summary>
/// Hand-written security DDL letting the collaboration service's retention sweep read each
/// workspace's version retention window.
/// </summary>
/// <remarks>
/// Frozen to the migration that applies it, like every other file of this kind: a later phase
/// writes its own equivalent rather than editing this one.
/// </remarks>
internal static class CollabWorkspaceRetentionReadSecuritySql
{
    /// <summary>The role the collaboration service connects as.</summary>
    private const string CollaborationRole = "nix_collab";

    /// <summary>Emits every statement, in dependency order.</summary>
    /// <param name="emit">Sends one statement batch to the migration.</param>
    /// <remarks>
    /// <para>
    /// The sweep (<c>apps/collab/src/documents/retention.ts</c>) joins <c>content_doc</c> to
    /// <c>workspace</c> to find each document's retention window. <c>ContentVersions</c> shipped
    /// the sweep without this grant, so on any database built from migrations alone the sweep
    /// failed with "permission denied for table workspace".
    /// </para>
    /// <para>
    /// Column-level, the shape the <c>item_closure</c> and <c>item_lock</c> grants take: the join
    /// keys and the window, not the workspace's name, quota or lifecycle. The table's forced
    /// tenant policy still applies to every row.
    /// </para>
    /// </remarks>
    internal static void Apply(Action<string> emit)
    {
        ArgumentNullException.ThrowIfNull(emit);

        emit($"""
            GRANT SELECT (tenant_id, workspace_id, version_retention_days) ON workspace TO {CollaborationRole};
            """);
    }

    /// <summary>Undoes <see cref="Apply"/>.</summary>
    /// <param name="emit">Sends one statement batch to the migration.</param>
    internal static void Revert(Action<string> emit)
    {
        ArgumentNullException.ThrowIfNull(emit);

        emit($"""
            REVOKE SELECT (tenant_id, workspace_id, version_retention_days) ON workspace FROM {CollaborationRole};
            """);
    }
}
