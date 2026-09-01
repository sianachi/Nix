namespace Nix.Persistence.Migrations;

/// <summary>Tenant isolation and runtime grants for durable document-import staging.</summary>
public static class DocumentImportSecuritySql
{
    public static void Apply(Action<string> emit)
    {
        ArgumentNullException.ThrowIfNull(emit);
        foreach (var table in new[] { "document_import", "document_import_item" })
        {
            emit($"""
                ALTER TABLE {table} ENABLE ROW LEVEL SECURITY;
                ALTER TABLE {table} FORCE ROW LEVEL SECURITY;
                CREATE POLICY {table}_tenant_isolation ON {table}
                    USING (tenant_id = NULLIF(current_setting('nix.tenant_id', true), '')::uuid)
                    WITH CHECK (tenant_id = NULLIF(current_setting('nix.tenant_id', true), '')::uuid);
                REVOKE ALL ON {table} FROM PUBLIC;
                GRANT SELECT, INSERT, UPDATE, DELETE ON {table} TO nix_app;
                """);
        }
    }

    public static void Revert(Action<string> emit)
    {
        ArgumentNullException.ThrowIfNull(emit);
        foreach (var table in new[] { "document_import_item", "document_import" })
        {
            emit($"""
                DROP POLICY IF EXISTS {table}_tenant_isolation ON {table};
                REVOKE ALL ON {table} FROM nix_app;
                """);
        }
    }
}
