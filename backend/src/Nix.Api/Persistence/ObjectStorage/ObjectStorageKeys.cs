using System.Security.Cryptography;
using System.Text;
using Nix.Domain.Files;
using Nix.Domain.Importing;
using Nix.Domain.Tenancy;

namespace Nix.Persistence.ObjectStorage;

/// <summary>Stable private-object names; upload staging and immutable versions never share a key.</summary>
public static class ObjectStorageKeys
{
    private const string FileVersionPrefix = "files/versions/";
    private const string FileThumbnailPrefix = "files/thumbnails/";

    public static string FileUpload(TenantId tenantId, FileUploadId uploadId) =>
        $"files/uploads/{tenantId}/{uploadId}";

    public static string FileVersion(TenantId tenantId, FileVersionId versionId) =>
        $"files/versions/{tenantId}/{versionId}";

    public static string FileVersion(TenantId tenantId, FileUploadId uploadId) =>
        $"files/versions/{tenantId}/{uploadId}";

    /// <summary>
    /// The key of the JPEG thumbnail derived from one file version's object, which is the only place
    /// that rule exists in Core.
    /// </summary>
    /// <remarks>
    /// The worker never derives or sees this key: Core signs the upload capability for it, so the
    /// two sides cannot disagree. The key is a function of the version key alone, lives under its own
    /// prefix and ends in <c>.jpg</c>, so it cannot equal any user-visible object key (all of which
    /// are server-assigned) and a file's thumbnail is found, and deleted, from the file's own key.
    /// </remarks>
    public static string FileThumbnail(string versionObjectKey)
    {
        ArgumentNullException.ThrowIfNull(versionObjectKey);
        if (!versionObjectKey.StartsWith(FileVersionPrefix, StringComparison.Ordinal))
        {
            throw new ArgumentException("A thumbnail is derived only from a file version key.", nameof(versionObjectKey));
        }

        return string.Concat(FileThumbnailPrefix, versionObjectKey.AsSpan(FileVersionPrefix.Length), ".jpg");
    }

    /// <summary>
    /// Derives the thumbnail key when <paramref name="objectKey"/> is a file version key, and says
    /// no for any other key. For bulk cleanup, which sees every kind of key.
    /// </summary>
    public static bool TryFileThumbnail(string objectKey, out string thumbnailKey)
    {
        ArgumentNullException.ThrowIfNull(objectKey);
        if (objectKey.StartsWith(FileVersionPrefix, StringComparison.Ordinal))
        {
            thumbnailKey = FileThumbnail(objectKey);
            return true;
        }

        thumbnailKey = string.Empty;
        return false;
    }

    /// <summary>The thumbnail key for the file version a completed upload will publish.</summary>
    public static string FileThumbnail(TenantId tenantId, FileUploadId uploadId) =>
        FileThumbnail(FileVersion(tenantId, uploadId));

    public static string ImportPlan(TenantId tenantId, DocumentImportId importId) =>
        $"imports/plans/{tenantId}/{importId}.json";

    /// <summary>Builds the immutable key for one signed WebAssembly component version.</summary>
    public static string PluginComponent(
        TenantId tenantId,
        string componentId,
        string version,
        string sha256)
    {
        ArgumentNullException.ThrowIfNull(componentId);
        ArgumentNullException.ThrowIfNull(version);
        ArgumentNullException.ThrowIfNull(sha256);
        var identity = componentId.Split('/');
        if (identity.Length != 2
            || identity.Any(segment => string.IsNullOrWhiteSpace(segment)
                || segment.Length > 128
                || segment is "." or ".."
                || segment.Any(character => !(char.IsAsciiLetterOrDigit(character)
                    || character is '.' or '-' or '_')))
            || string.IsNullOrWhiteSpace(version)
            || version.Length > 64
            || version.Any(character => !(char.IsAsciiLetterOrDigit(character)
                || character is '.' or '-' or '+'))
            || sha256 is not { Length: 64 }
            || sha256.Any(character => !char.IsAsciiHexDigit(character)))
        {
            throw new ArgumentException("The plugin component object identity is invalid.");
        }

        return $"plugins/components/{tenantId}/{identity[0]}/{identity[1]}/{version}/{sha256.ToUpperInvariant()}.wasm";
    }

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
            || key.StartsWith($"files/thumbnails/{tenant}/", StringComparison.Ordinal)
            || key.StartsWith($"imports/plans/{tenant}/", StringComparison.Ordinal)
            || key.StartsWith($"plugins/components/{tenant}/", StringComparison.Ordinal)
            || key.StartsWith($"exports/results/{tenant}/", StringComparison.Ordinal);
    }
}
