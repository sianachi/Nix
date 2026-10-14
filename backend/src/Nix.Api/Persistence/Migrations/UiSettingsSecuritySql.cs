namespace Nix.Persistence.Migrations;

/// <summary>
/// Row security for <c>principal_ui_settings</c>: a principal reads and writes only their own row,
/// through the application role alone. Mirrors <c>workspace_arrangement</c>.
/// </summary>
public static class UiSettingsSecuritySql
{
    private const string ApplicationRole = "nix_app";

    /// <summary>Enables and forces RLS with the owner policy, and grants the application role its DML.</summary>
    /// <param name="emit">Receives each statement.</param>
    public static void Apply(Action<string> emit)
    {
        ArgumentNullException.ThrowIfNull(emit);
        emit($"""
            ALTER TABLE principal_ui_settings ENABLE ROW LEVEL SECURITY;
            ALTER TABLE principal_ui_settings FORCE ROW LEVEL SECURITY;
            CREATE POLICY principal_ui_settings_owner ON principal_ui_settings
            USING (
                tenant_id = NULLIF(current_setting('nix.tenant_id', true), '')::uuid
                AND principal_id = NULLIF(current_setting('nix.principal_id', true), '')::uuid
            )
            WITH CHECK (
                tenant_id = NULLIF(current_setting('nix.tenant_id', true), '')::uuid
                AND principal_id = NULLIF(current_setting('nix.principal_id', true), '')::uuid
            );
            REVOKE ALL ON principal_ui_settings FROM PUBLIC;
            GRANT SELECT, INSERT, UPDATE, DELETE ON principal_ui_settings TO {ApplicationRole};
            """);
    }
}
