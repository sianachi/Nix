namespace Nix.Persistence.Migrations;

/// <summary>Protects archive-import file version capabilities with tenant RLS and bounded metadata.</summary>
public static class DocumentImportFileVersionSecuritySql
{
    public static void Apply(Action<string> emit)
    {
        ArgumentNullException.ThrowIfNull(emit);
        emit("""
            ALTER TABLE document_import_file_version ENABLE ROW LEVEL SECURITY;
            ALTER TABLE document_import_file_version FORCE ROW LEVEL SECURITY;
            CREATE POLICY document_import_file_version_tenant_isolation ON document_import_file_version
                USING (tenant_id = NULLIF(current_setting('nix.tenant_id', true), '')::uuid)
                WITH CHECK (tenant_id = NULLIF(current_setting('nix.tenant_id', true), '')::uuid);
            REVOKE ALL ON document_import_file_version FROM PUBLIC;
            GRANT SELECT, INSERT, UPDATE, DELETE ON document_import_file_version TO nix_app;
            ALTER TABLE document_import_file_version ADD CONSTRAINT document_import_file_version_metadata_bounds
                CHECK (byte_length BETWEEN 0 AND 104857600
                    AND sha256 ~ '^[0-9a-f]{64}$'
                    AND (pixel_width IS NULL) = (pixel_height IS NULL)
                    AND (pixel_width IS NULL OR (pixel_width > 0 AND pixel_height > 0)));
            """);
    }

    public static void Revert(Action<string> emit)
    {
        ArgumentNullException.ThrowIfNull(emit);
        emit("ALTER TABLE document_import_file_version DISABLE ROW LEVEL SECURITY;");
    }
}
