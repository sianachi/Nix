using Nix.Domain.Identity;
using Nix.Domain.Provisioning;
using Nix.Domain.Tenancy;

namespace Nix.Tests.Domain;

public sealed class DeterministicProvisioningIdTests
{
    private static readonly TenantId Tenant =
        TenantId.From(Guid.Parse("a0000000-0000-4000-8000-000000000001"));

    [Fact]
    public void Normative_vectors_fix_the_cross_implementation_protocol()
    {
        var principal = DeterministicProvisioningId.Principal(
            Tenant,
            "https://sso.example.test",
            "subject-123");
        var workspace = DeterministicProvisioningId.PersonalWorkspace(principal);

        Assert.Equal(Guid.Parse("a122cd4b-c0de-8253-bd79-39268034e9e0"), principal.Value);
        Assert.Equal(Guid.Parse("a223a8a8-2d53-8a5a-82ba-a33b57dd8b3d"), workspace.Value);
        Assert.Equal(
            Guid.Parse("c1e197d7-e0e3-8d22-9f37-5aa0bf4cd6b3"),
            DeterministicProvisioningId.DailyNotesRoot(workspace));
        Assert.Equal(
            Guid.Parse("ccf9ed8d-7ee0-83e4-81f8-afeb647964b1"),
            DeterministicProvisioningId.DatedDailyNote(workspace, "2026-08-30"));
        Assert.Equal(
            Guid.Parse("3f5ff704-5fc3-86ea-8eca-1ffd2c24ae36"),
            DeterministicProvisioningId.PresetObject(workspace, "seed.kanban", "template"));
    }

    [Fact]
    public void Exact_issuer_and_subject_bytes_are_significant()
    {
        var canonical = DeterministicProvisioningId.Principal(Tenant, "https://issuer.test", "subject");
        var changedCase = DeterministicProvisioningId.Principal(Tenant, "https://ISSUER.test", "subject");
        var changedSubject = DeterministicProvisioningId.Principal(Tenant, "https://issuer.test", "Subject");

        Assert.NotEqual(canonical, changedCase);
        Assert.NotEqual(canonical, changedSubject);
    }

    [Fact]
    public void Every_derived_identifier_is_uuid_version_8_with_the_rfc_variant()
    {
        var id = DeterministicProvisioningId.Principal(Tenant, "https://issuer.test", "subject").Value;
        Span<byte> bytes = stackalloc byte[16];
        Assert.True(id.TryWriteBytes(bytes, bigEndian: true, out _));
        Assert.Equal(8, bytes[6] >> 4);
        Assert.Equal(2, bytes[8] >> 6);
    }
}
