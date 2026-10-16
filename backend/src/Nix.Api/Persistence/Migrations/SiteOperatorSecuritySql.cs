namespace Nix.Persistence.Migrations;

/// <summary>Row security for <c>site_operator</c>: tenant isolation, and no UPDATE (a grant is added or removed whole).</summary>
internal static class SiteOperatorSecuritySql
{
    /// <summary>Enables and forces RLS with the tenant policy, then narrows the application role.</summary>
    /// <param name="emit">Receives each statement.</param>
    internal static void Apply(Action<string> emit)
    {
        ArgumentNullException.ThrowIfNull(emit);
        emit("""
            ALTER TABLE site_operator ENABLE ROW LEVEL SECURITY;
            ALTER TABLE site_operator FORCE ROW LEVEL SECURITY;
            DROP POLICY IF EXISTS site_operator_tenant_isolation ON site_operator;
            CREATE POLICY site_operator_tenant_isolation ON site_operator
                USING (tenant_id = NULLIF(current_setting('nix.tenant_id', true), '')::uuid)
                WITH CHECK (tenant_id = NULLIF(current_setting('nix.tenant_id', true), '')::uuid);
            REVOKE ALL ON site_operator FROM PUBLIC, nix_app, nix_collab;
            GRANT SELECT, INSERT, DELETE ON site_operator TO nix_app;
            """);
    }
}
