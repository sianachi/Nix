using Microsoft.EntityFrameworkCore;
using Nix.Abstractions;
using Nix.Abstractions.Files;
using Nix.Domain.Files;
using Nix.Domain.Items;
using Nix.Domain.Properties;
using Nix.Domain.Workers;
using Nix.Persistence.ObjectStorage;

namespace Nix.Persistence.Files;

public sealed class FileStore(
    NixDbContext database,
    IItemTree tree,
    IPermissionResolver permissions,
    INixSessionContextAccessor session,
    TimeProvider clock) : IFileStore
{
    private const long MaxFileBytes = 100L * 1024 * 1024;

    public async ValueTask<FileUploadRecord?> BeginAsync(BeginFileUpload request, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(request);
        var context = Context;
        await LockIdempotencyAsync(request.IdempotencyKey, cancellationToken).ConfigureAwait(false);
        var existing = await database.FileUploads.AsNoTracking().SingleOrDefaultAsync(
            upload => upload.TenantId == context.TenantId && upload.ActorId == context.PrincipalId && upload.IdempotencyKey == request.IdempotencyKey,
            cancellationToken).ConfigureAwait(false);
        if (existing is not null)
        {
            return existing.WorkspaceId == request.WorkspaceId
                && existing.ParentId == request.ParentId
                && existing.TargetItemId == request.TargetItemId
                && string.Equals(existing.Purpose, request.Purpose, StringComparison.Ordinal)
                && string.Equals(existing.FileName, request.FileName, StringComparison.Ordinal)
                && string.Equals(existing.DeclaredMediaType, request.DeclaredMediaType, StringComparison.OrdinalIgnoreCase)
                && existing.DeclaredByteLength == request.DeclaredByteLength
                    ? ToUpload(existing)
                    : null;
        }
        if (request.Purpose is not (FileUploadPurposes.File
            or FileUploadPurposes.DocumentImport
            or FileUploadPurposes.TemplateImport))
        {
            throw new InvalidOperationException("The file upload purpose is invalid.");
        }
        if (request.DeclaredByteLength < 0 || request.DeclaredByteLength > MaxFileBytes)
        {
            throw new InvalidOperationException("The file exceeds the 100 MiB upload limit.");
        }

        var now = clock.GetUtcNow();
        var id = FileUploadId.Create();
        var upload = new FileUpload
        {
            Id = id,
            TenantId = context.TenantId,
            WorkspaceId = request.WorkspaceId,
            ParentId = request.ParentId,
            TargetItemId = request.TargetItemId,
            ActorId = context.PrincipalId,
            IdempotencyKey = request.IdempotencyKey,
            Purpose = request.Purpose,
            FileName = request.FileName,
            DeclaredMediaType = request.DeclaredMediaType,
            DeclaredByteLength = request.DeclaredByteLength,
            ObjectKey = ObjectStorageKeys.FileUpload(context.TenantId, id),
            Status = "pending_upload",
            ExpiresAt = now.AddMinutes(15),
            CreatedAt = now,
            UpdatedAt = now,
        };
        database.FileUploads.Add(upload);
        await database.SaveChangesAsync(cancellationToken).ConfigureAwait(false);
        return ToUpload(upload);
    }

    public async ValueTask<FileUploadRecord?> QueueInspectionAsync(
        FileUploadId id,
        CancellationToken cancellationToken)
    {
        var context = Context;
        await LockUploadAsync(id, cancellationToken).ConfigureAwait(false);
        var upload = await database.FileUploads.AsTracking().SingleOrDefaultAsync(
            candidate => candidate.TenantId == context.TenantId
                && candidate.ActorId == context.PrincipalId
                && candidate.Id == id,
            cancellationToken).ConfigureAwait(false);
        if (upload is null
            || upload.Purpose != FileUploadPurposes.File
            || upload.ExpiresAt <= clock.GetUtcNow()
            || upload.Status is "cancelled" or "failed")
        {
            return null;
        }
        if (upload.Status == "pending_upload")
        {
            upload.Status = "inspection_queued";
            upload.UpdatedAt = clock.GetUtcNow();
            await database.SaveChangesAsync(cancellationToken).ConfigureAwait(false);
        }
        return ToUpload(upload);
    }

    public async ValueTask<FileUploadInspectionRecord?> GetInspectionAsync(
        FileUploadId id,
        CancellationToken cancellationToken)
    {
        var context = Context;
        var upload = await database.FileUploads.AsNoTracking().SingleOrDefaultAsync(
            candidate => candidate.TenantId == context.TenantId
                && candidate.ActorId == context.PrincipalId
                && candidate.Id == id,
            cancellationToken).ConfigureAwait(false);
        return upload is null ? null : new FileUploadInspectionRecord(
            upload.Id.Value,
            upload.WorkspaceId.Value,
            upload.Purpose,
            upload.Status,
            upload.ObjectKey,
            upload.FileName,
            upload.DeclaredMediaType,
            upload.DeclaredByteLength,
            upload.ExpiresAt,
            upload.PublishedItemId?.Value);
    }

    public async ValueTask<FileRecord?> CompleteAsync(CompleteFileUpload request, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(request);
        var context = Context;
        await LockUploadAsync(request.UploadId, cancellationToken).ConfigureAwait(false);
        var upload = await database.FileUploads.AsTracking().SingleOrDefaultAsync(
            candidate => candidate.TenantId == context.TenantId && candidate.ActorId == context.PrincipalId && candidate.Id == request.UploadId,
            cancellationToken).ConfigureAwait(false);
        if (upload is null || upload.Purpose != FileUploadPurposes.File)
        {
            return null;
        }
        if (upload.Status == "completed" && upload.PublishedItemId is { } published)
        {
            return await GetAsync(published, cancellationToken).ConfigureAwait(false);
        }
        if (upload.Status != "inspection_queued" || upload.ExpiresAt <= clock.GetUtcNow())
        {
            return null;
        }
        if (request.ByteLength < 0 || request.ByteLength > MaxFileBytes || request.ByteLength != upload.DeclaredByteLength)
        {
            return null;
        }
        if (!await permissions.CanWriteWorkspaceAsync(upload.WorkspaceId, cancellationToken).ConfigureAwait(false))
        {
            return null;
        }
        if (upload.ParentId is { } parent)
        {
            var parentItem = await tree.FindAsync(parent, cancellationToken).ConfigureAwait(false);
            if (parentItem is null || parentItem.WorkspaceId != upload.WorkspaceId)
            {
                return null;
            }
        }
        if (upload.TargetItemId is { } targetItemId)
        {
            var targetItem = await tree.FindAsync(targetItemId, cancellationToken).ConfigureAwait(false);
            if (targetItem is not { Type: "file" } || targetItem.WorkspaceId != upload.WorkspaceId)
            {
                return null;
            }
        }

        // Completion already runs inside NixUnitOfWorkMiddleware's transaction. A transaction-
        // scoped advisory lock serializes quota decisions per workspace, so two uploads cannot
        // both observe the same remaining bytes and over-commit the quota.
        await database.Database.ExecuteSqlInterpolatedAsync(
            $"SELECT pg_advisory_xact_lock(hashtextextended({upload.WorkspaceId.Value.ToString()}, 0))",
            cancellationToken).ConfigureAwait(false);
        var quota = await database.Workspaces
            .Where(workspace => workspace.TenantId == context.TenantId && workspace.Id == upload.WorkspaceId)
            .Select(workspace => workspace.StorageQuotaBytes)
            .SingleAsync(cancellationToken)
            .ConfigureAwait(false);
        var used = await database.FileVersions
            .Where(version => version.TenantId == context.TenantId && version.WorkspaceId == upload.WorkspaceId)
            .SumAsync(version => (long?)version.ByteLength, cancellationToken)
            .ConfigureAwait(false) ?? 0;
        if (request.ByteLength > quota - used)
        {
            return null;
        }

        ItemId itemId;
        var nextVersion = 1;
        if (upload.TargetItemId is { } target)
        {
            var body = await database.FileBodies.AsTracking().SingleOrDefaultAsync(candidate => candidate.TenantId == context.TenantId && candidate.ItemId == target, cancellationToken).ConfigureAwait(false);
            if (body is null)
            {
                return null;
            }
            itemId = target;
            nextVersion = 1 + await database.FileVersions.Where(version => version.TenantId == context.TenantId && version.ItemId == target).MaxAsync(version => version.Version, cancellationToken).ConfigureAwait(false);
        }
        else
        {
            itemId = ItemId.Create();
            var now = clock.GetUtcNow();
            var item = new Item
            {
                Id = itemId,
                TenantId = context.TenantId,
                WorkspaceId = upload.WorkspaceId,
                Type = "file",
                ParentId = upload.ParentId,
                Seq = await tree.NextSiblingSequenceAsync(upload.WorkspaceId, upload.ParentId, cancellationToken).ConfigureAwait(false),
                Properties = ItemProperties.WithTitle(null, upload.FileName),
                LifecycleState = ItemLifecycleState.Active,
                CreatedBy = context.PrincipalId,
                LastModifiedBy = context.PrincipalId,
                CreatedAt = now,
                LastModifiedAt = now,
            };
            await tree.InsertAsync(item, cancellationToken).ConfigureAwait(false);
        }

        var version = new FileVersion
        {
            Id = FileVersionId.Create(),
            TenantId = context.TenantId,
            WorkspaceId = upload.WorkspaceId,
            ItemId = itemId,
            Version = nextVersion,
            ObjectKey = ObjectStorageKeys.FileVersion(context.TenantId, upload.Id),
            FileName = upload.FileName,
            MediaType = request.DetectedMediaType,
            ByteLength = request.ByteLength,
            Sha256 = request.Sha256,
            Previewable = request.Previewable,
            PixelWidth = request.PixelWidth,
            PixelHeight = request.PixelHeight,
            CreatedBy = context.PrincipalId,
            CreatedAt = clock.GetUtcNow(),
        };
        database.FileVersions.Add(version);
        var fileBody = await database.FileBodies.AsTracking().SingleOrDefaultAsync(candidate => candidate.TenantId == context.TenantId && candidate.ItemId == itemId, cancellationToken).ConfigureAwait(false);
        if (fileBody is null)
        {
            database.FileBodies.Add(new FileBody { TenantId = context.TenantId, WorkspaceId = upload.WorkspaceId, ItemId = itemId, CurrentVersionId = version.Id });
        }
        else
        {
            fileBody.CurrentVersionId = version.Id;
        }
        upload.PublishedItemId = itemId;
        upload.Status = "completed";
        upload.UpdatedAt = clock.GetUtcNow();
        // A new file item is covered by the deferred item trigger. Replacement changes only the
        // current immutable file version, so it needs one explicit projection refresh.
        if (upload.TargetItemId is not null)
        {
            database.WorkerOutboxEvents.Add(new WorkerOutboxEvent
            {
                Id = WorkerOutboxEventId.Create(),
                TenantId = context.TenantId,
                WorkspaceId = upload.WorkspaceId,
                ItemId = itemId,
                Kind = "item.changed",
                Payload = "{}",
                AvailableAt = upload.UpdatedAt,
            });
        }
        await database.SaveChangesAsync(cancellationToken).ConfigureAwait(false);
        return await GetAsync(itemId, cancellationToken).ConfigureAwait(false);
    }

    public async ValueTask<bool> RejectAsync(
        FileUploadId id,
        string failureCode,
        CancellationToken cancellationToken)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(failureCode);
        if (failureCode.Length > 80)
        {
            throw new ArgumentOutOfRangeException(nameof(failureCode));
        }
        var context = Context;
        await LockUploadAsync(id, cancellationToken).ConfigureAwait(false);
        var upload = await database.FileUploads.AsTracking().SingleOrDefaultAsync(
            candidate => candidate.TenantId == context.TenantId
                && candidate.ActorId == context.PrincipalId
                && candidate.Id == id,
            cancellationToken).ConfigureAwait(false);
        if (upload is null || upload.Status == "completed")
        {
            return false;
        }
        upload.Status = "failed";
        upload.FailureCode = failureCode;
        upload.UpdatedAt = clock.GetUtcNow();
        await database.SaveChangesAsync(cancellationToken).ConfigureAwait(false);
        return true;
    }

    public async ValueTask<FileUploadRecord?> GetUploadAsync(FileUploadId id, CancellationToken cancellationToken)
    {
        var context = Context;
        var upload = await database.FileUploads.AsNoTracking().SingleOrDefaultAsync(candidate => candidate.TenantId == context.TenantId && candidate.ActorId == context.PrincipalId && candidate.Id == id, cancellationToken).ConfigureAwait(false);
        return upload is null ? null : ToUpload(upload);
    }

    public async ValueTask<bool> CancelAsync(FileUploadId id, CancellationToken cancellationToken)
    {
        var context = Context;
        await LockUploadAsync(id, cancellationToken).ConfigureAwait(false);
        var upload = await database.FileUploads.AsTracking().SingleOrDefaultAsync(candidate => candidate.TenantId == context.TenantId && candidate.ActorId == context.PrincipalId && candidate.Id == id, cancellationToken).ConfigureAwait(false);
        if (upload is null || upload.Status == "completed")
        {
            return false;
        }
        upload.Status = "cancelled";
        upload.UpdatedAt = clock.GetUtcNow();
        await database.SaveChangesAsync(cancellationToken).ConfigureAwait(false);
        return true;
    }

    public async ValueTask<FileRecord?> GetAsync(ItemId itemId, CancellationToken cancellationToken)
    {
        var context = Context;
        var body = await database.FileBodies.AsNoTracking().SingleOrDefaultAsync(candidate => candidate.TenantId == context.TenantId && candidate.ItemId == itemId, cancellationToken).ConfigureAwait(false);
        if (body is null
            || !await permissions.CanReadWorkspaceAsync(body.WorkspaceId, cancellationToken).ConfigureAwait(false)
            || await tree.FindAsync(itemId, cancellationToken).ConfigureAwait(false) is null)
        {
            return null;
        }
        var versions = await database.FileVersions.AsNoTracking().Where(candidate => candidate.TenantId == context.TenantId && candidate.ItemId == itemId).OrderByDescending(candidate => candidate.Version).ToListAsync(cancellationToken).ConfigureAwait(false);
        var mapped = versions.Select(version => ToVersion(version, version.Id == body.CurrentVersionId)).ToArray();
        return new FileRecord(itemId.Value, body.WorkspaceId.Value, mapped.Single(version => version.Current), mapped);
    }

    public async ValueTask<FileDownloadRecord?> AuthorizeDownloadAsync(ItemId itemId, FileVersionId? versionId, CancellationToken cancellationToken)
    {
        var context = Context;
        var body = await database.FileBodies.AsNoTracking().SingleOrDefaultAsync(candidate => candidate.TenantId == context.TenantId && candidate.ItemId == itemId, cancellationToken).ConfigureAwait(false);
        if (body is null
            || !await permissions.CanReadWorkspaceAsync(body.WorkspaceId, cancellationToken).ConfigureAwait(false)
            || await tree.FindAsync(itemId, cancellationToken).ConfigureAwait(false) is null)
        {
            return null;
        }
        var wanted = versionId ?? body.CurrentVersionId;
        var version = await database.FileVersions.AsNoTracking().SingleOrDefaultAsync(candidate => candidate.TenantId == context.TenantId && candidate.ItemId == itemId && candidate.Id == wanted, cancellationToken).ConfigureAwait(false);
        return version is null ? null : new(version.ObjectKey, version.FileName, version.MediaType, version.ByteLength, version.Sha256, version.Previewable);
    }

    private NixSessionContext Context => session.Current ?? throw new InvalidOperationException("No session context; the pipeline must establish one.");

    private Task<int> LockUploadAsync(FileUploadId id, CancellationToken cancellationToken)
    {
        var context = Context;
        return database.Database.ExecuteSqlInterpolatedAsync(
            $"SELECT pg_advisory_xact_lock(hashtextextended({$"file-upload:{context.TenantId.Value:N}:{id.Value:N}"}, 0))",
            cancellationToken);
    }

    private Task<int> LockIdempotencyAsync(string idempotencyKey, CancellationToken cancellationToken)
    {
        var context = Context;
        return database.Database.ExecuteSqlInterpolatedAsync(
            $"SELECT pg_advisory_xact_lock(hashtextextended({$"file-upload-key:{context.TenantId.Value:N}:{context.PrincipalId.Value:N}:{idempotencyKey}"}, 0))",
            cancellationToken);
    }

    private static FileUploadRecord ToUpload(FileUpload value) => new(value.Id.Value, value.WorkspaceId.Value, value.Purpose, value.Status, value.ObjectKey, value.ExpiresAt, value.PublishedItemId?.Value, value.FailureCode);
    private static FileVersionRecord ToVersion(FileVersion value, bool current) => new(value.Id.Value, value.Version, value.FileName, value.MediaType, value.ByteLength, value.Sha256, value.Previewable, value.PixelWidth, value.PixelHeight, value.CreatedAt, current);
}
