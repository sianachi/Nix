using System.Security.Cryptography;
using System.Text;
using Nix.Domain.Files;
using Nix.Domain.Importing;
using Nix.Domain.Tenancy;

namespace Nix.Persistence.ObjectStorage;

/// <summary>Stable private-object names; upload staging and immutable versions never share a key.</summary>
public static class ObjectStorageKeys
{
    public static string FileUpload(TenantId tenantId, FileUploadId uploadId) =>
        $"files/uploads/{tenantId}/{uploadId}";

    public static string FileVersion(TenantId tenantId, FileVersionId versionId) =>
        $"files/versions/{tenantId}/{versionId}";

    public static string FileVersion(TenantId tenantId, FileUploadId uploadId) =>
        $"files/versions/{tenantId}/{uploadId}";

    public static string ImportPlan(TenantId tenantId, DocumentImportId importId) =>
        $"imports/plans/{tenantId}/{importId}.json";

    public static Guid ExportAttempt(Guid exportId, string executionId)
    {
        if (exportId == Guid.Empty
            || string.IsNullOrWhiteSpace(executionId)
            || executionId.Length > 128
            || executionId.Any(char.IsControl))
        {
            throw new ArgumentException("The export execution identity is invalid.");
        }

        Span<byte> source = stackalloc byte[16 + (128 * 4)];
        if (!exportId.TryWriteBytes(source[..16]))
        {
            throw new InvalidOperationException("The export identity could not be encoded.");
        }
        var written = Encoding.UTF8.GetBytes(executionId, source[16..]);
        Span<byte> digest = stackalloc byte[SHA256.HashSizeInBytes];
        SHA256.HashData(source[..(16 + written)], digest);
        return new Guid(digest[..16]);
    }

    public static string ExportResult(
        TenantId tenantId,
        Guid exportId,
        Guid attemptId,
        string extension)
    {
        if (exportId == Guid.Empty
            || attemptId == Guid.Empty
            || string.IsNullOrWhiteSpace(extension)
            || extension.Length > 16
            || extension.Any(character => !char.IsAsciiDigit(character)
                && character is not (>= 'a' and <= 'z')))
        {
            throw new ArgumentException("The export object identity is invalid.");
        }

        return $"exports/results/{tenantId}/{exportId:D}/{attemptId:D}.{extension}";
    }

    public static bool BelongsTo(TenantId tenantId, string key)
    {
        if (string.IsNullOrWhiteSpace(key) || key.Length > 1024)
        {
            return false;
        }
        var tenant = tenantId.ToString();
        return key.StartsWith($"files/uploads/{tenant}/", StringComparison.Ordinal)
            || key.StartsWith($"files/versions/{tenant}/", StringComparison.Ordinal)
            || key.StartsWith($"imports/plans/{tenant}/", StringComparison.Ordinal)
            || key.StartsWith($"exports/results/{tenant}/", StringComparison.Ordinal);
    }
}
