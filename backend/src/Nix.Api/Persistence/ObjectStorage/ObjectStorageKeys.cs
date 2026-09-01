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
