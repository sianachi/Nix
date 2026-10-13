namespace Nix.Persistence.Migrations;

/// <summary>
/// Row security for <c>workspace_arrangement</c>: a principal reads and writes only their own row,
/// through the application role alone. Mirrors <c>principal_preferences</c>.
/// </summary>
public static class WorkspaceArrangementSecuritySql
{
    private const string ApplicationRole = "nix_app";

    /// <summary>Enables and forces RLS with the owner policy, and grants the application role its DML.</summary>
    /// <param name="emit">Receives each statement.</param>
    public static void Apply(Action<string> emit)
    {
        ArgumentNullException.ThrowIfNull(emit);
        emit($"""
            ALTER TABLE workspace_arrangement ENABLE ROW LEVEL SECURITY;
            ALTER TABLE workspace_arrangement FORCE ROW LEVEL SECURITY;
            CREATE POLICY workspace_arrangement_owner ON workspace_arrangement
            USING (
                tenant_id = NULLIF(current_setting('nix.tenant_id', true), '')::uuid
                AND principal_id = NULLIF(current_setting('nix.principal_id', true), '')::uuid
            )
            WITH CHECK (
                tenant_id = NULLIF(current_setting('nix.tenant_id', true), '')::uuid
                AND principal_id = NULLIF(current_setting('nix.principal_id', true), '')::uuid
            );
            REVOKE ALL ON workspace_arrangement FROM PUBLIC;
            GRANT SELECT, INSERT, UPDATE, DELETE ON workspace_arrangement TO {ApplicationRole};
            """);
    }
}
