using System.Buffers.Binary;
using System.Globalization;
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
    private const string DatedDailyNoteSuccessorPurpose = "nix:provisioning:dated-daily-note-successor:v1";
    private const string DailyNotesFolderPurpose = "nix:provisioning:daily-notes-folder:v1";
    private const string DailyNotesRootSuccessorPurpose = "nix:provisioning:daily-notes-root-successor:v1";
    private const string DailyNotesFolderSuccessorPurpose = "nix:provisioning:daily-notes-folder-successor:v1";
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

    /// <summary>
    /// How many identifiers a daily note, a Daily Notes folder or the root can move through. A
    /// purged item is terminal, so each purge (or move to another workspace) retires one identifier
    /// and the next open starts anew under the following generation.
    /// </summary>
    public const int DailyNoteGenerations = 64;

    /// <summary>Derives the original Daily Notes root for a workspace (generation 0).</summary>
    public static Guid DailyNotesRoot(WorkspaceId workspaceId) =>
        Derive(DailyNotesRootPurpose, workspaceId.Value);

    /// <summary>
    /// Derives one generation of the Daily Notes root. Generation 0 is the original identifier the
    /// personal provisioner creates; a later one replaces a root that was purged.
    /// </summary>
    public static Guid DailyNotesRoot(WorkspaceId workspaceId, int generation)
    {
        ArgumentOutOfRangeException.ThrowIfNegative(generation);
        return generation == 0
            ? DailyNotesRoot(workspaceId)
            : Derive(DailyNotesRootSuccessorPurpose, workspaceId.Value,
                generation.ToString(CultureInfo.InvariantCulture));
    }

    /// <summary>Every generation of the Daily Notes root, in order.</summary>
    public static Guid[] DailyNotesRootGenerations(WorkspaceId workspaceId) =>
        Generations(generation => DailyNotesRoot(workspaceId, generation));

    /// <summary>Derives one dated Daily Note from its canonical route date.</summary>
    public static Guid DatedDailyNote(WorkspaceId workspaceId, string canonicalDate) =>
        DatedDailyNote(workspaceId, canonicalDate, 0);

    /// <summary>
    /// Derives one generation of a dated Daily Note. Generation 0 is the original identifier, so
    /// notes created before generations existed keep theirs; a later generation is the successor a
    /// day moves to once every earlier identifier is purged or held by another workspace.
    /// </summary>
    public static Guid DatedDailyNote(WorkspaceId workspaceId, string canonicalDate, int generation)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(canonicalDate);
        ArgumentOutOfRangeException.ThrowIfNegative(generation);
        return generation == 0
            ? Derive(DatedDailyNotePurpose, workspaceId.Value, canonicalDate)
            : Derive(DatedDailyNoteSuccessorPurpose, workspaceId.Value, canonicalDate,
                generation.ToString(CultureInfo.InvariantCulture));
    }

    /// <summary>
    /// Derives one Daily Notes folder from its key: the year (<c>2026</c>) or the year-month
    /// (<c>2026-10</c>).
    /// </summary>
    public static Guid DailyNotesFolder(WorkspaceId workspaceId, string key) =>
        DailyNotesFolder(workspaceId, key, 0);

    /// <summary>
    /// Derives one generation of a Daily Notes folder. Generation 0 is the original identifier; a
    /// later one replaces a folder that was purged or no longer sits where the tree needs it.
    /// </summary>
    public static Guid DailyNotesFolder(WorkspaceId workspaceId, string key, int generation)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(key);
        ArgumentOutOfRangeException.ThrowIfNegative(generation);
        return generation == 0
            ? Derive(DailyNotesFolderPurpose, workspaceId.Value, key)
            : Derive(DailyNotesFolderSuccessorPurpose, workspaceId.Value, key,
                generation.ToString(CultureInfo.InvariantCulture));
    }

    /// <summary>Every generation of one Daily Notes folder, in order.</summary>
    public static Guid[] DailyNotesFolderGenerations(WorkspaceId workspaceId, string key) =>
        Generations(generation => DailyNotesFolder(workspaceId, key, generation));

    /// <summary>Every generation of one dated Daily Note, in order.</summary>
    public static Guid[] DatedDailyNoteGenerations(WorkspaceId workspaceId, string canonicalDate) =>
        Generations(generation => DatedDailyNote(workspaceId, canonicalDate, generation));

    private static Guid[] Generations(Func<int, Guid> derive)
    {
        var identifiers = new Guid[DailyNoteGenerations];
        for (var generation = 0; generation < identifiers.Length; generation++)
        {
            identifiers[generation] = derive(generation);
        }

        return identifiers;
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
