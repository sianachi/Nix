namespace Nix.Persistence.Migrations;

/// <summary>Enables tenant isolation and bounded metadata for template file-copy stages.</summary>
public static class TemplateFileTransferSecuritySql
{
    public static void Apply(Action<string> emit)
    {
        ArgumentNullException.ThrowIfNull(emit);
        emit("""
            ALTER TABLE template_file_transfer ENABLE ROW LEVEL SECURITY;
            ALTER TABLE template_file_transfer FORCE ROW LEVEL SECURITY;
            CREATE POLICY template_file_transfer_tenant_isolation ON template_file_transfer
                USING (tenant_id = NULLIF(current_setting('nix.tenant_id', true), '')::uuid)
                WITH CHECK (tenant_id = NULLIF(current_setting('nix.tenant_id', true), '')::uuid);
            REVOKE ALL ON template_file_transfer FROM PUBLIC;
            GRANT SELECT, INSERT, UPDATE, DELETE ON template_file_transfer TO nix_app;
            ALTER TABLE template_file_transfer ADD CONSTRAINT template_file_transfer_metadata_bounds
                CHECK (byte_length BETWEEN 0 AND 104857600
                    AND sha256 ~ '^[0-9a-f]{64}$'
                    AND (pixel_width IS NULL) = (pixel_height IS NULL)
                    AND (pixel_width IS NULL OR (pixel_width > 0 AND pixel_height > 0)));
            """);
    }

    public static void Revert(Action<string> emit)
    {
        ArgumentNullException.ThrowIfNull(emit);
        emit("ALTER TABLE template_file_transfer DISABLE ROW LEVEL SECURITY;");
    }
}
