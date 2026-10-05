namespace Nix.Persistence.Migrations;

/// <summary>Principal and tenant isolation for private companion settings.</summary>
public static class PetPreferencesSecuritySql
{
    /// <summary>Applies fail-closed read and write policies, including the table owner.</summary>
    public static void Apply(Action<string> emit)
    {
        ArgumentNullException.ThrowIfNull(emit);
        emit("""
            ALTER TABLE pet_preferences ENABLE ROW LEVEL SECURITY;
            ALTER TABLE pet_preferences FORCE ROW LEVEL SECURITY;
            CREATE POLICY pet_preferences_owner ON pet_preferences
            USING (
                tenant_id = NULLIF(current_setting('nix.tenant_id', true), '')::uuid
                AND principal_id = NULLIF(current_setting('nix.principal_id', true), '')::uuid
            )
            WITH CHECK (
                tenant_id = NULLIF(current_setting('nix.tenant_id', true), '')::uuid
                AND principal_id = NULLIF(current_setting('nix.principal_id', true), '')::uuid
            );
            """);
    }
}
