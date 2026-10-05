namespace Nix.Persistence.Migrations;

/// <summary>The hand-written tenant boundary and grants for public form links.</summary>
public static class PublicFormSecuritySql
{
    /// <summary>Enables forced tenant isolation and grants the runtime role its required DML.</summary>
    /// <param name="emit">Sends a SQL batch to the migration.</param>
    public static void Apply(Action<string> emit)
    {
        ArgumentNullException.ThrowIfNull(emit);
        emit("""
            ALTER TABLE public_form_link ENABLE ROW LEVEL SECURITY;
            ALTER TABLE public_form_link FORCE ROW LEVEL SECURITY;

            DROP POLICY IF EXISTS public_form_link_tenant_isolation ON public_form_link;
            CREATE POLICY public_form_link_tenant_isolation ON public_form_link
                USING (tenant_id = NULLIF(current_setting('nix.tenant_id', true), '')::uuid)
                WITH CHECK (tenant_id = NULLIF(current_setting('nix.tenant_id', true), '')::uuid);

            REVOKE ALL ON public_form_link FROM PUBLIC;
            GRANT SELECT, INSERT, UPDATE, DELETE ON public_form_link TO nix_app;
            """);
    }
}
