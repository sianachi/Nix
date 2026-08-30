using System.Buffers.Binary;
using System.Security.Cryptography;
using System.Text;
using Nix.Domain.Identity;
using Nix.Domain.Tenancy;

namespace Nix.Domain.Provisioning;

/// <summary>Derives stable UUIDv8 identifiers for idempotent first-login provisioning.</summary>
public static class DeterministicProvisioningId
{
    private const string PrincipalPurpose = "nix:provisioning:principal:v1";
    private const string PersonalWorkspacePurpose = "nix:provisioning:personal-workspace:v1";
    private const string DailyNotesRootPurpose = "nix:provisioning:daily-notes-root:v1";
    private const string DatedDailyNotePurpose = "nix:provisioning:dated-daily-note:v1";
    private const string PresetObjectPurpose = "nix:provisioning:preset-object:v1";

    /// <summary>Derives a principal from tenant, exact issuer, and exact subject.</summary>
    public static PrincipalId Principal(TenantId tenantId, string issuer, string subject)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(issuer);
        ArgumentException.ThrowIfNullOrWhiteSpace(subject);
        return PrincipalId.From(Derive(PrincipalPurpose, tenantId.Value, issuer, subject));
    }

    /// <summary>Derives the one personal workspace for a principal.</summary>
    public static WorkspaceId PersonalWorkspace(PrincipalId principalId) =>
        WorkspaceId.From(Derive(PersonalWorkspacePurpose, principalId.Value));

    /// <summary>Derives the Daily Notes root for a workspace.</summary>
    public static Guid DailyNotesRoot(WorkspaceId workspaceId) =>
        Derive(DailyNotesRootPurpose, workspaceId.Value);

    /// <summary>Derives one dated Daily Note from its canonical route date.</summary>
    public static Guid DatedDailyNote(WorkspaceId workspaceId, string canonicalDate)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(canonicalDate);
        return Derive(DatedDailyNotePurpose, workspaceId.Value, canonicalDate);
    }

    /// <summary>Derives one shipped preset object.</summary>
    public static Guid PresetObject(WorkspaceId workspaceId, string stableKey, string objectKindSuffix)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(stableKey);
        ArgumentException.ThrowIfNullOrWhiteSpace(objectKindSuffix);
        return Derive(PresetObjectPurpose, workspaceId.Value, stableKey, objectKindSuffix);
    }

    private static Guid Derive(string purpose, params object[] values)
    {
        using var hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
        AppendString(hash, purpose);
        Span<byte> uuid = stackalloc byte[16];
        foreach (var value in values)
        {
            switch (value)
            {
                case Guid guid:
                    guid.TryWriteBytes(uuid, bigEndian: true, out _);
                    Append(hash, uuid);
                    break;
                case string text:
                    AppendString(hash, text);
                    break;
                default:
                    throw new InvalidOperationException("Provisioning identifiers accept only UUID and string inputs.");
            }
        }

        Span<byte> digest = stackalloc byte[32];
        if (!hash.TryGetHashAndReset(digest, out var written) || written != digest.Length)
        {
            throw new CryptographicException("SHA-256 did not produce its fixed-length digest.");
        }

        digest[6] = (byte)((digest[6] & 0x0f) | 0x80);
        digest[8] = (byte)((digest[8] & 0x3f) | 0x80);
        return new Guid(digest[..16], bigEndian: true);
    }

    private static void AppendString(IncrementalHash hash, string value)
    {
        var byteCount = Encoding.UTF8.GetByteCount(value);
        Span<byte> length = stackalloc byte[sizeof(uint)];
        BinaryPrimitives.WriteUInt32BigEndian(length, checked((uint)byteCount));
        hash.AppendData(length);

        if (byteCount <= 1024)
        {
            Span<byte> bytes = stackalloc byte[byteCount];
            Encoding.UTF8.GetBytes(value, bytes);
            hash.AppendData(bytes);
            return;
        }

        // Provisioning inputs are bounded by their boundary validators. This fallback keeps the
        // protocol correct if the utility is exercised independently without a large stack frame.
        var bytesArray = Encoding.UTF8.GetBytes(value);
        hash.AppendData(bytesArray);
    }

    private static void Append(IncrementalHash hash, ReadOnlySpan<byte> value)
    {
        Span<byte> length = stackalloc byte[sizeof(uint)];
        BinaryPrimitives.WriteUInt32BigEndian(length, checked((uint)value.Length));
        hash.AppendData(length);
        hash.AppendData(value);
    }
}
