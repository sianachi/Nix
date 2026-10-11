using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Migrations;

namespace Nix.Persistence.Migrations.Generated;

/// <summary>Adds immutable per-principal creation receipts independent of the EF item model.</summary>
[DbContext(typeof(NixDbContext))]
[Migration("20261011100000_ItemCreationReceipts")]
public sealed class ItemCreationReceipts : Migration
{
    /// <inheritdoc />
    protected override void Up(MigrationBuilder migrationBuilder) => migrationBuilder.Sql("""
        CREATE TABLE item_creation_receipt (
            tenant_id uuid NOT NULL,
            principal_id uuid NOT NULL,
            request_key uuid NOT NULL CHECK (request_key <> '00000000-0000-0000-0000-000000000000'),
            request_hash bytea NOT NULL CHECK (octet_length(request_hash) = 32),
            item_id uuid NOT NULL,
            PRIMARY KEY (tenant_id, principal_id, request_key),
            FOREIGN KEY (tenant_id, principal_id) REFERENCES principal(tenant_id, principal_id) ON DELETE CASCADE
        );
        ALTER TABLE item_creation_receipt ENABLE ROW LEVEL SECURITY;
        ALTER TABLE item_creation_receipt FORCE ROW LEVEL SECURITY;
        CREATE POLICY item_creation_receipt_isolation ON item_creation_receipt
            USING (tenant_id = NULLIF(current_setting('nix.tenant_id', true), '')::uuid
                AND principal_id = NULLIF(current_setting('nix.principal_id', true), '')::uuid)
            WITH CHECK (tenant_id = NULLIF(current_setting('nix.tenant_id', true), '')::uuid
                AND principal_id = NULLIF(current_setting('nix.principal_id', true), '')::uuid);
        REVOKE ALL ON item_creation_receipt FROM PUBLIC, nix_app;
        GRANT SELECT, INSERT ON item_creation_receipt TO nix_app;
        """);

    /// <inheritdoc />
    protected override void Down(MigrationBuilder migrationBuilder) =>
        migrationBuilder.Sql("DROP TABLE item_creation_receipt;");
}
