using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using Nix.Abstractions;
using Nix.Abstractions.Files;
using Nix.Abstractions.Importing;
using Nix.Domain.Files;
using Nix.Domain.Importing;
using Nix.Domain.Items;
using Nix.Domain.Properties;
using Nix.Domain.Templates;
using Nix.Domain.Workers;
using Nix.Persistence.ObjectStorage;
using Npgsql;
using NpgsqlTypes;

namespace Nix.Persistence.Importing;

public sealed class DocumentImportStore(
    NixDbContext database,
    IItemTree tree,
    IPermissionResolver permissions,
    INixSessionContextAccessor session,
    TemplateDefinitionValidator validator,
    TimeProvider clock) : IDocumentImportStore
{
    private const int MaximumItems = 10_000;
    private const int MaximumDepth = 64;
    private const long MaximumFileBytes = 100L * 1024 * 1024;
    private static readonly TimeSpan ImportLifetime = TimeSpan.FromHours(2);

    public async ValueTask<DocumentImportRecord?> BeginAsync(
        BeginDocumentImport request,
        CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(request);
        var context = Context;
        await LockIdempotencyAsync(request.IdempotencyKey, cancellationToken).ConfigureAwait(false);
        var existing = await database.DocumentImports.AsNoTracking().SingleOrDefaultAsync(
            candidate => candidate.TenantId == context.TenantId
                && candidate.ActorId == context.PrincipalId
                && candidate.IdempotencyKey == request.IdempotencyKey,
            cancellationToken).ConfigureAwait(false);
        if (existing is not null)
        {
            return existing.WorkspaceId == request.WorkspaceId
                && existing.UploadId == request.UploadId
                && existing.ParentId == request.ParentId
                && string.Equals(existing.Format, request.Format, StringComparison.Ordinal)
                && string.Equals(existing.Title, request.Title, StringComparison.Ordinal)
                    ? ToRecord(existing)
                    : null;
        }

        var upload = await database.FileUploads.AsNoTracking().SingleOrDefaultAsync(
            candidate => candidate.TenantId == context.TenantId
                && candidate.ActorId == context.PrincipalId
                && candidate.Id == request.UploadId,
            cancellationToken).ConfigureAwait(false);
        if (upload is null
            || upload.Purpose != FileUploadPurposes.DocumentImport
            || upload.WorkspaceId != request.WorkspaceId
            || upload.ParentId != request.ParentId
            || upload.Status != "pending_upload"
            || upload.ExpiresAt <= clock.GetUtcNow())
        {
            return null;
        }
        if (!await permissions.CanWriteWorkspaceAsync(request.WorkspaceId, cancellationToken).ConfigureAwait(false)
            || !await ValidParentAsync(request.WorkspaceId, request.ParentId, cancellationToken).ConfigureAwait(false))
        {
            return null;
        }

        var now = clock.GetUtcNow();
        var id = DocumentImportId.Create();
        var operation = new DocumentImport
        {
            Id = id,
            TenantId = context.TenantId,
            WorkspaceId = request.WorkspaceId,
            ActorId = context.PrincipalId,
            UploadId = request.UploadId,
            ParentId = request.ParentId,
            Format = request.Format,
            Title = request.Title,
            IdempotencyKey = request.IdempotencyKey,
            Status = DocumentImportStatuses.PendingUpload,
            PlanObjectKey = ObjectStorageKeys.ImportPlan(context.TenantId, id),
            ExpiresAt = now + ImportLifetime,
            CreatedAt = now,
            UpdatedAt = now,
        };
        database.DocumentImports.Add(operation);
        await database.SaveChangesAsync(cancellationToken).ConfigureAwait(false);
        return ToRecord(operation);
    }

    public async ValueTask<DocumentImportRecord?> GetAsync(
        DocumentImportId id,
        CancellationToken cancellationToken)
    {
        var context = Context;
        var operation = await database.DocumentImports.AsNoTracking().SingleOrDefaultAsync(
            candidate => candidate.TenantId == context.TenantId
                && candidate.ActorId == context.PrincipalId
                && candidate.Id == id,
            cancellationToken).ConfigureAwait(false);
        return operation is null ? null : ToRecord(operation);
    }

    public async ValueTask<DocumentImportExecutionRecord?> GetExecutionAsync(
        DocumentImportId id,
        CancellationToken cancellationToken)
    {
        var context = Context;
        var result = await (
            from operation in database.DocumentImports.AsNoTracking()
            join upload in database.FileUploads.AsNoTracking()
                on new { operation.TenantId, operation.UploadId }
                equals new { upload.TenantId, UploadId = upload.Id }
            where operation.TenantId == context.TenantId
                && operation.ActorId == context.PrincipalId
                && operation.Id == id
            select new { Operation = operation, Upload = upload })
            .SingleOrDefaultAsync(cancellationToken).ConfigureAwait(false);
        return result is null
            ? null
            : new DocumentImportExecutionRecord(
                ToRecord(result.Operation),
                result.Upload.ObjectKey,
                result.Upload.FileName,
                result.Upload.DeclaredMediaType,
                result.Upload.DeclaredByteLength);
    }

    public ValueTask<DocumentImportRecord?> AttachPreviewJobAsync(
        DocumentImportId id,
        WorkerJobId jobId,
        CancellationToken cancellationToken) =>
        AttachJobAsync(id, jobId, preview: true, cancellationToken);

    public async ValueTask<DocumentImportRecord?> CompletePreviewAsync(
        CompleteDocumentImportPreview request,
        CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(request);
        await LockImportAsync(request.ImportId, cancellationToken).ConfigureAwait(false);
        var operation = await OwnedTrackingAsync(request.ImportId, cancellationToken).ConfigureAwait(false);
        if (operation is null || operation.ExpiresAt <= clock.GetUtcNow())
        {
            return null;
        }
        if (operation.Status == DocumentImportStatuses.PreviewReady)
        {
            return operation.PlanSha256 == request.PlanSha256
                && operation.SourceSha256 == request.SourceSha256
                    ? ToRecord(operation)
                    : null;
        }
        if (operation.Status != DocumentImportStatuses.PreviewQueued)
        {
            return null;
        }
        operation.PlanSha256 = request.PlanSha256;
        operation.PlanByteLength = request.PlanByteLength;
        operation.SourceSha256 = request.SourceSha256;
        operation.ItemCount = request.ItemCount;
        operation.AssetCount = request.AssetCount;
        operation.Loss = request.Loss;
        operation.Omissions = request.Omissions;
        operation.Status = DocumentImportStatuses.PreviewReady;
        operation.UpdatedAt = clock.GetUtcNow();
        await database.SaveChangesAsync(cancellationToken).ConfigureAwait(false);
        return ToRecord(operation);
    }

    public ValueTask<DocumentImportRecord?> AttachCommitJobAsync(
        DocumentImportId id,
        WorkerJobId jobId,
        CancellationToken cancellationToken) =>
        AttachJobAsync(id, jobId, preview: false, cancellationToken);

    public async ValueTask<DocumentImportStageRecord?> StageAsync(
        StageDocumentImport request,
        CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(request);
        if (!ValidDigest(request.PlanSha256)
            || !ValidDigest(request.SourceSha256)
            || !TryValidatePlan(request.Items, out var ordered))
        {
            return null;
        }

        var context = Context;
        await LockImportAsync(request.ImportId, cancellationToken).ConfigureAwait(false);
        var operation = await OwnedTrackingAsync(request.ImportId, cancellationToken).ConfigureAwait(false);
        if (operation is null
            || operation.ExpiresAt <= clock.GetUtcNow()
            || operation.PlanSha256 != request.PlanSha256
            || operation.SourceSha256 != request.SourceSha256
            || operation.ItemCount != request.Items.Count)
        {
            return null;
        }
        if (operation.Status is DocumentImportStatuses.Staging or DocumentImportStatuses.Completed)
        {
            return await ReadStageAsync(operation, cancellationToken).ConfigureAwait(false);
        }
        if (operation.Status != DocumentImportStatuses.CommitQueued
            || !await permissions.CanWriteWorkspaceAsync(operation.WorkspaceId, cancellationToken).ConfigureAwait(false)
            || !await ValidParentAsync(operation.WorkspaceId, operation.ParentId, cancellationToken).ConfigureAwait(false))
        {
            return null;
        }

        if (await database.DocumentImportItems.AnyAsync(
            value => value.TenantId == context.TenantId && value.ImportId == operation.Id,
            cancellationToken).ConfigureAwait(false))
        {
            return await ReadStageAsync(operation, cancellationToken).ConfigureAwait(false);
        }

        var upload = await database.FileUploads.AsTracking().SingleOrDefaultAsync(
            candidate => candidate.TenantId == context.TenantId
                && candidate.ActorId == context.PrincipalId
                && candidate.Id == operation.UploadId,
            cancellationToken).ConfigureAwait(false);
        if (upload is null
            || upload.Purpose != FileUploadPurposes.DocumentImport
            || upload.Status != "pending_upload"
            || upload.DeclaredByteLength > MaximumFileBytes)
        {
            return null;
        }

        var plannedFiles = ordered.Where(item => item.File is not null).Select(item => item.File!).ToArray();
        var sourceFiles = plannedFiles.Where(file => file.SourceKind == "source").ToArray();
        var expectedSourceFiles = operation.Format is "pdf" or "docx" or "txt" ? 1 : 0;
        if (sourceFiles.Length != expectedSourceFiles
            || plannedFiles.Count(file => file.SourceKind == "asset") != operation.AssetCount
            || sourceFiles.Any(file => file.ByteLength != upload.DeclaredByteLength
                || !string.Equals(file.Sha256, operation.SourceSha256, StringComparison.Ordinal)
                || !string.Equals(file.FileName, upload.FileName, StringComparison.Ordinal)))
        {
            return null;
        }

        long fileBytes = 0;
        try
        {
            foreach (var file in plannedFiles)
            {
                fileBytes = checked(fileBytes + file.ByteLength);
            }
        }
        catch (OverflowException)
        {
            return null;
        }
        if (!await FitsQuotaAsync(operation.WorkspaceId, fileBytes, cancellationToken).ConfigureAwait(false))
        {
            return null;
        }

        var now = clock.GetUtcNow();
        var targetIds = ordered.ToDictionary(item => item.SourceId, _ => ItemId.Create(), StringComparer.Ordinal);
        var root = ordered.Single(item => item.ParentSourceId is null);
        var rootSequence = await tree.NextSiblingSequenceAsync(
            operation.WorkspaceId,
            operation.ParentId,
            cancellationToken).ConfigureAwait(false);
        var siblingIndexes = new Dictionary<string, long>(StringComparer.Ordinal);
        var items = new List<Item>(ordered.Count);
        var mappings = new List<DocumentImportItem>(ordered.Count);
        var versions = new List<FileVersion>();
        var bodies = new List<FileBody>();
        foreach (var planned in ordered)
        {
            var targetId = targetIds[planned.SourceId];
            var parentId = planned.ParentSourceId is null
                ? operation.ParentId
                : targetIds[planned.ParentSourceId];
            var siblingKey = planned.ParentSourceId ?? "$root";
            var siblingIndex = siblingIndexes.GetValueOrDefault(siblingKey);
            siblingIndexes[siblingKey] = siblingIndex + 1;
            var sequence = planned.ParentSourceId is null ? rootSequence : checked((siblingIndex + 1) * 1024);
            var item = new Item
            {
                Id = targetId,
                TenantId = context.TenantId,
                WorkspaceId = operation.WorkspaceId,
                Type = planned.ItemType,
                ParentId = parentId,
                Seq = sequence,
                Properties = ItemProperties.WithTitle(planned.Properties, planned.Title),
                Schema = planned.Schema,
                Views = planned.Views,
                LifecycleState = ItemLifecycleState.Provisioning,
                CreatedBy = context.PrincipalId,
                LastModifiedBy = context.PrincipalId,
                CreatedAt = now,
                LastModifiedAt = now,
            };
            items.Add(item);

            FileVersionId? fileVersionId = null;
            string? objectKey = null;
            var objectReady = planned.File is null;
            if (planned.File is { } file)
            {
                fileVersionId = FileVersionId.Create();
                objectKey = ObjectStorageKeys.FileVersion(context.TenantId, fileVersionId.Value);
                objectReady = false;
                versions.Add(new FileVersion
                {
                    Id = fileVersionId.Value,
                    TenantId = context.TenantId,
                    WorkspaceId = operation.WorkspaceId,
                    ItemId = targetId,
                    Version = 1,
                    ObjectKey = objectKey,
                    FileName = file.FileName,
                    MediaType = file.MediaType,
                    ByteLength = file.ByteLength,
                    Sha256 = file.Sha256,
                    Previewable = file.Previewable,
                    PixelWidth = file.PixelWidth,
                    PixelHeight = file.PixelHeight,
                    CreatedBy = context.PrincipalId,
                    CreatedAt = now,
                });
                bodies.Add(new FileBody
                {
                    TenantId = context.TenantId,
                    WorkspaceId = operation.WorkspaceId,
                    ItemId = targetId,
                    CurrentVersionId = fileVersionId.Value,
                });
            }
            mappings.Add(new DocumentImportItem
            {
                ImportId = operation.Id,
                TenantId = context.TenantId,
                SourceId = planned.SourceId,
                ParentSourceId = planned.ParentSourceId,
                TargetItemId = targetId,
                ItemType = planned.ItemType,
                FinalLifecycleState = planned.FinalLifecycleState,
                BodyRequired = planned.BodyRequired,
                FileVersionId = fileVersionId,
                ObjectKey = objectKey,
                ObjectReady = objectReady,
            });
        }

        database.Items.AddRange(items);
        database.DocumentImportItems.AddRange(mappings);
        database.FileVersions.AddRange(versions);
        database.FileBodies.AddRange(bodies);
        operation.RootItemId = targetIds[root.SourceId];
        operation.Status = DocumentImportStatuses.Staging;
        operation.UpdatedAt = now;
        await database.SaveChangesAsync(cancellationToken).ConfigureAwait(false);
        await RebuildClosureAsync(items.Select(item => item.Id), cancellationToken).ConfigureAwait(false);
        return new DocumentImportStageRecord(
            operation.Id.Value,
            operation.RootItemId.Value.Value,
            mappings.Select(ToMapping).ToArray());
    }

    public async ValueTask<bool> MarkObjectReadyAsync(
        DocumentImportId id,
        string sourceId,
        long byteLength,
        string sha256,
        CancellationToken cancellationToken)
    {
        var context = Context;
        await LockImportAsync(id, cancellationToken).ConfigureAwait(false);
        var operation = await OwnedTrackingAsync(id, cancellationToken).ConfigureAwait(false);
        if (operation is null || operation.Status != DocumentImportStatuses.Staging)
        {
            return false;
        }
        var mapping = await database.DocumentImportItems.AsTracking().SingleOrDefaultAsync(
            value => value.TenantId == context.TenantId
                && value.ImportId == id
                && value.SourceId == sourceId,
            cancellationToken).ConfigureAwait(false);
        if (mapping?.FileVersionId is not { } fileVersionId)
        {
            return false;
        }
        var version = await database.FileVersions.AsNoTracking().SingleOrDefaultAsync(
            value => value.TenantId == context.TenantId && value.Id == fileVersionId,
            cancellationToken).ConfigureAwait(false);
        if (version is null
            || version.ByteLength != byteLength
            || !string.Equals(version.Sha256, sha256, StringComparison.Ordinal))
        {
            return false;
        }
        mapping.ObjectReady = true;
        operation.UpdatedAt = clock.GetUtcNow();
        await database.SaveChangesAsync(cancellationToken).ConfigureAwait(false);
        return true;
    }

    public async ValueTask<DocumentImportObjectRecord?> AuthorizeObjectUploadAsync(
        DocumentImportId id,
        string sourceId,
        CancellationToken cancellationToken)
    {
        var context = Context;
        return await (
            from operation in database.DocumentImports.AsNoTracking()
            join item in database.DocumentImportItems.AsNoTracking()
                on new { operation.TenantId, ImportId = operation.Id }
                equals new { item.TenantId, item.ImportId }
            join version in database.FileVersions.AsNoTracking()
                on new { item.TenantId, Id = item.FileVersionId!.Value }
                equals new { version.TenantId, version.Id }
            where operation.TenantId == context.TenantId
                && operation.ActorId == context.PrincipalId
                && operation.Id == id
                && operation.Status == DocumentImportStatuses.Staging
                && operation.ExpiresAt > clock.GetUtcNow()
                && item.SourceId == sourceId
                && item.FileVersionId != null
                && item.ObjectKey != null
            select new DocumentImportObjectRecord(
                item.SourceId,
                item.ObjectKey!,
                version.MediaType,
                version.ByteLength,
                version.Sha256,
                item.ObjectReady))
            .SingleOrDefaultAsync(cancellationToken).ConfigureAwait(false);
    }

    public async ValueTask<DocumentImportStageRecord?> AuthorizeBodyWritesAsync(
        DocumentImportId id,
        CancellationToken cancellationToken)
    {
        var context = Context;
        var operation = await database.DocumentImports.AsNoTracking().SingleOrDefaultAsync(
            value => value.TenantId == context.TenantId
                && value.ActorId == context.PrincipalId
                && value.Id == id
                && value.Status == DocumentImportStatuses.Staging
                && value.ExpiresAt > clock.GetUtcNow(),
            cancellationToken).ConfigureAwait(false);
        return operation is null ? null : await ReadStageAsync(operation, cancellationToken).ConfigureAwait(false);
    }

    public async ValueTask<DocumentImportRecord?> FinalizeAsync(
        DocumentImportId id,
        CancellationToken cancellationToken)
    {
        var context = Context;
        await LockImportAsync(id, cancellationToken).ConfigureAwait(false);
        var operation = await OwnedTrackingAsync(id, cancellationToken).ConfigureAwait(false);
        if (operation is null)
        {
            return null;
        }
        if (operation.Status == DocumentImportStatuses.Completed)
        {
            return ToRecord(operation);
        }
        if (operation.Status != DocumentImportStatuses.Staging
            || operation.ExpiresAt <= clock.GetUtcNow()
            || !await permissions.CanWriteWorkspaceAsync(operation.WorkspaceId, cancellationToken).ConfigureAwait(false)
            || !await ValidParentAsync(operation.WorkspaceId, operation.ParentId, cancellationToken).ConfigureAwait(false))
        {
            return null;
        }

        var mappings = await database.DocumentImportItems.AsNoTracking()
            .Where(value => value.TenantId == context.TenantId && value.ImportId == id)
            .ToListAsync(cancellationToken).ConfigureAwait(false);
        if (mappings.Count == 0
            || mappings.Count != operation.ItemCount
            || mappings.Any(value => value.FileVersionId is not null && !value.ObjectReady))
        {
            return null;
        }
        var expectedBodies = mappings.Where(value => value.BodyRequired).Select(value => value.TargetItemId).ToHashSet();
        var actualBodies = await database.ContentDocs.AsNoTracking()
            .Where(value => value.TenantId == context.TenantId
                && mappings.Select(mapping => mapping.TargetItemId).Contains(value.ItemId))
            .Select(value => value.ItemId)
            .ToListAsync(cancellationToken).ConfigureAwait(false);
        if (!expectedBodies.SetEquals(actualBodies))
        {
            return null;
        }

        var activeIds = mappings.Where(value => value.FinalLifecycleState == "active")
            .Select(value => value.TargetItemId).ToArray();
        var deletedIds = mappings.Where(value => value.FinalLifecycleState == "deleted")
            .Select(value => value.TargetItemId).ToArray();
        if (activeIds.Length > 0)
        {
            await database.Items.IgnoreQueryFilters()
                .Where(value => value.TenantId == context.TenantId && activeIds.Contains(value.Id))
                .ExecuteUpdateAsync(update => update.SetProperty(
                    value => value.LifecycleState,
                    ItemLifecycleState.Active), cancellationToken).ConfigureAwait(false);
        }
        if (deletedIds.Length > 0)
        {
            await database.Items.IgnoreQueryFilters()
                .Where(value => value.TenantId == context.TenantId && deletedIds.Contains(value.Id))
                .ExecuteUpdateAsync(update => update.SetProperty(
                    value => value.LifecycleState,
                    ItemLifecycleState.Deleted), cancellationToken).ConfigureAwait(false);
        }

        var now = clock.GetUtcNow();
        operation.Status = DocumentImportStatuses.Completed;
        operation.UpdatedAt = now;
        operation.CompletedAt = now;
        var upload = await database.FileUploads.AsTracking().SingleAsync(
            value => value.TenantId == context.TenantId && value.Id == operation.UploadId,
            cancellationToken).ConfigureAwait(false);
        upload.Status = "completed";
        upload.PublishedItemId = mappings.SingleOrDefault(value => value.ObjectKey == upload.ObjectKey)?.TargetItemId
            ?? operation.RootItemId;
        upload.UpdatedAt = now;
        await AddOutboxEventsAsync(operation, mappings, now, cancellationToken).ConfigureAwait(false);
        await database.SaveChangesAsync(cancellationToken).ConfigureAwait(false);
        return ToRecord(operation);
    }

    public ValueTask<DocumentImportCleanupRecord?> FailAsync(
        DocumentImportId id,
        string failureCode,
        CancellationToken cancellationToken) =>
        TerminateAsync(id, DocumentImportStatuses.Failed, failureCode, cancellationToken);

    public ValueTask<DocumentImportCleanupRecord?> CancelAsync(
        DocumentImportId id,
        CancellationToken cancellationToken) =>
        TerminateAsync(id, DocumentImportStatuses.Cancelled, null, cancellationToken);

    private async ValueTask<DocumentImportRecord?> AttachJobAsync(
        DocumentImportId id,
        WorkerJobId jobId,
        bool preview,
        CancellationToken cancellationToken)
    {
        await LockImportAsync(id, cancellationToken).ConfigureAwait(false);
        var operation = await OwnedTrackingAsync(id, cancellationToken).ConfigureAwait(false);
        if (operation is null || operation.ExpiresAt <= clock.GetUtcNow())
        {
            return null;
        }
        if (preview)
        {
            if (operation.PreviewJobId is { } existing)
            {
                return existing == jobId ? ToRecord(operation) : null;
            }
            if (operation.Status != DocumentImportStatuses.PendingUpload)
            {
                return null;
            }
            operation.PreviewJobId = jobId;
            operation.Status = DocumentImportStatuses.PreviewQueued;
        }
        else
        {
            if (operation.CommitJobId is { } existing)
            {
                return existing == jobId ? ToRecord(operation) : null;
            }
            if (operation.Status != DocumentImportStatuses.PreviewReady)
            {
                return null;
            }
            operation.CommitJobId = jobId;
            operation.Status = DocumentImportStatuses.CommitQueued;
        }
        operation.UpdatedAt = clock.GetUtcNow();
        await database.SaveChangesAsync(cancellationToken).ConfigureAwait(false);
        return ToRecord(operation);
    }

    private async ValueTask<DocumentImportCleanupRecord?> TerminateAsync(
        DocumentImportId id,
        string status,
        string? failureCode,
        CancellationToken cancellationToken)
    {
        var context = Context;
        await LockImportAsync(id, cancellationToken).ConfigureAwait(false);
        var operation = await OwnedTrackingAsync(id, cancellationToken).ConfigureAwait(false);
        if (operation is null)
        {
            return null;
        }
        if (operation.Status == DocumentImportStatuses.Completed)
        {
            return null;
        }
        var mappings = await database.DocumentImportItems.AsNoTracking()
            .Where(value => value.TenantId == context.TenantId && value.ImportId == id)
            .ToArrayAsync(cancellationToken).ConfigureAwait(false);
        var upload = await database.FileUploads.AsTracking().SingleOrDefaultAsync(
            value => value.TenantId == context.TenantId && value.Id == operation.UploadId,
            cancellationToken).ConfigureAwait(false);
        var objectKeys = mappings
            .Where(value => value.ObjectKey is not null)
            .Select(value => value.ObjectKey!)
            .Append(operation.PlanObjectKey)
            .Concat(upload is null ? [] : [upload.ObjectKey])
            .Distinct(StringComparer.Ordinal)
            .Order(StringComparer.Ordinal)
            .ToArray();
        var cleanup = new DocumentImportCleanupRecord(operation.WorkspaceId.Value, objectKeys);
        if (operation.Status is DocumentImportStatuses.Cancelled or DocumentImportStatuses.Failed)
        {
            return cleanup;
        }
        var targetIds = mappings.Select(value => value.TargetItemId).ToArray();
        operation.RootItemId = null;
        operation.Status = status;
        operation.FailureCode = failureCode;
        operation.UpdatedAt = clock.GetUtcNow();
        operation.CompletedAt = operation.UpdatedAt;
        if (upload is not null && upload.Status != "completed")
        {
            upload.Status = status == DocumentImportStatuses.Cancelled ? "cancelled" : "failed";
            upload.FailureCode = failureCode;
            upload.UpdatedAt = operation.UpdatedAt;
        }
        await database.SaveChangesAsync(cancellationToken).ConfigureAwait(false);
        if (targetIds.Length > 0)
        {
            await database.Items.IgnoreQueryFilters()
                .Where(value => value.TenantId == context.TenantId && targetIds.Contains(value.Id))
                .ExecuteDeleteAsync(cancellationToken).ConfigureAwait(false);
        }
        return cleanup;
    }

    private Task<int> LockImportAsync(
        DocumentImportId id,
        CancellationToken cancellationToken)
    {
        var context = Context;
        return database.Database.ExecuteSqlInterpolatedAsync(
            $"SELECT pg_advisory_xact_lock(hashtextextended({$"document-import:{context.TenantId.Value:N}:{id.Value:N}"}, 0))",
            cancellationToken);
    }

    private Task<int> LockIdempotencyAsync(
        string idempotencyKey,
        CancellationToken cancellationToken)
    {
        var context = Context;
        return database.Database.ExecuteSqlInterpolatedAsync(
            $"SELECT pg_advisory_xact_lock(hashtextextended({$"document-import-key:{context.TenantId.Value:N}:{context.PrincipalId.Value:N}:{idempotencyKey}"}, 0))",
            cancellationToken);
    }

    private async ValueTask AddOutboxEventsAsync(
        DocumentImport operation,
        IReadOnlyList<DocumentImportItem> mappings,
        DateTimeOffset now,
        CancellationToken cancellationToken)
    {
        var context = Context;
        var ids = mappings.Select(value => value.TargetItemId).ToArray();
        var items = await database.Items.IgnoreQueryFilters().AsNoTracking()
            .Where(value => value.TenantId == context.TenantId && ids.Contains(value.Id))
            .ToDictionaryAsync(value => value.Id, cancellationToken).ConfigureAwait(false);
        var fileVersions = await database.FileVersions.AsNoTracking()
            .Where(value => value.TenantId == context.TenantId && ids.Contains(value.ItemId))
            .ToDictionaryAsync(value => value.ItemId, cancellationToken).ConfigureAwait(false);
        foreach (var mapping in mappings)
        {
            var item = items[mapping.TargetItemId];
            fileVersions.TryGetValue(item.Id, out var file);
            database.WorkerOutboxEvents.Add(new WorkerOutboxEvent
            {
                Id = WorkerOutboxEventId.Create(),
                TenantId = context.TenantId,
                WorkspaceId = operation.WorkspaceId,
                ItemId = item.Id,
                Kind = "item.changed",
                Payload = JsonSerializer.Serialize(new Dictionary<string, object?>
                {
                    ["item_id"] = item.Id.Value,
                    ["parent_id"] = item.ParentId?.Value,
                    ["title"] = ItemProperties.ReadTitle(item.Properties),
                    ["body"] = string.Empty,
                    ["property_text"] = file is null
                        ? item.Properties ?? string.Empty
                        : $"{file.FileName} {file.MediaType}",
                    ["properties"] = item.Properties is null
                        ? new Dictionary<string, object?>()
                        : JsonSerializer.Deserialize<JsonElement>(item.Properties),
                    ["ancestor_ids"] = Array.Empty<string>(),
                    ["links"] = Array.Empty<string>(),
                    ["authorization_keys"] = Array.Empty<string>(),
                    ["lifecycle_state"] = mapping.FinalLifecycleState,
                    ["source_version"] = "1",
                    ["source_updated_at"] = now,
                }),
                AvailableAt = now,
            });
        }
    }

    private async ValueTask<bool> FitsQuotaAsync(
        Nix.Domain.Tenancy.WorkspaceId workspaceId,
        long bytes,
        CancellationToken cancellationToken)
    {
        if (bytes < 0)
        {
            return false;
        }
        await database.Database.ExecuteSqlInterpolatedAsync(
            $"SELECT pg_advisory_xact_lock(hashtextextended({workspaceId.Value.ToString()}, 0))",
            cancellationToken).ConfigureAwait(false);
        var context = Context;
        var quota = await database.Workspaces.AsNoTracking()
            .Where(value => value.TenantId == context.TenantId && value.Id == workspaceId)
            .Select(value => value.StorageQuotaBytes)
            .SingleAsync(cancellationToken).ConfigureAwait(false);
        var used = await database.FileVersions.AsNoTracking()
            .Where(value => value.TenantId == context.TenantId && value.WorkspaceId == workspaceId)
            .SumAsync(value => (long?)value.ByteLength, cancellationToken).ConfigureAwait(false) ?? 0;
        return bytes <= quota - used;
    }

    private async ValueTask<bool> ValidParentAsync(
        Nix.Domain.Tenancy.WorkspaceId workspaceId,
        ItemId? parentId,
        CancellationToken cancellationToken)
    {
        if (parentId is null)
        {
            return true;
        }
        var parent = await tree.FindAsync(parentId.Value, cancellationToken).ConfigureAwait(false);
        return parent is not null && parent.WorkspaceId == workspaceId;
    }

    private bool TryValidatePlan(
        IReadOnlyList<ImportEnvelopePlan> plans,
        out IReadOnlyList<ImportEnvelopePlan> ordered)
    {
        ordered = Array.Empty<ImportEnvelopePlan>();
        if (plans.Count is < 1 or > MaximumItems)
        {
            return false;
        }
        var byId = new Dictionary<string, ImportEnvelopePlan>(plans.Count, StringComparer.Ordinal);
        foreach (var plan in plans)
        {
            if (!ValidSourceId(plan.SourceId)
                || !byId.TryAdd(plan.SourceId, plan)
                || (plan.ParentSourceId is not null && !ValidSourceId(plan.ParentSourceId))
                || plan.Order < 0
                || string.IsNullOrWhiteSpace(plan.Title)
                || plan.Title.Length > 500
                || string.IsNullOrWhiteSpace(plan.ItemType)
                || plan.ItemType.Length > 64
                || plan.FinalLifecycleState is not ("active" or "deleted")
                || (plan.ItemType == "file") != (plan.File is not null)
                || (plan.File is not null && plan.BodyRequired)
                || !ValidFile(plan.File))
            {
                return false;
            }
        }
        if (byId.Values.Count(value => value.ParentSourceId is null) != 1)
        {
            return false;
        }

        var sorted = new List<ImportEnvelopePlan>(plans.Count);
        var state = new Dictionary<string, byte>(plans.Count, StringComparer.Ordinal);
        bool Visit(ImportEnvelopePlan value, int depth)
        {
            if (depth > MaximumDepth)
            {
                return false;
            }
            if (state.GetValueOrDefault(value.SourceId) == 2)
            {
                return true;
            }
            if (state.GetValueOrDefault(value.SourceId) == 1)
            {
                return false;
            }
            state[value.SourceId] = 1;
            if (value.ParentSourceId is { } parentId)
            {
                if (!byId.TryGetValue(parentId, out var parent) || !Visit(parent, depth + 1))
                {
                    return false;
                }
            }
            state[value.SourceId] = 2;
            sorted.Add(value);
            return true;
        }
        foreach (var plan in plans.OrderBy(value => value.Order))
        {
            if (!Visit(plan, 0))
            {
                return false;
            }
        }

        var effectiveSchemas = new Dictionary<string, PropertySchema>(plans.Count, StringComparer.Ordinal);
        foreach (var plan in sorted)
        {
            var declared = PropertySchemaJson.Read(plan.Schema);
            var effective = plan.ParentSourceId is { } parentId && declared.Inherit
                ? PropertySchema.Merge(effectiveSchemas[parentId], declared)
                : declared;
            effectiveSchemas[plan.SourceId] = effective;
            if (validator.ValidateEnvelope(
                ItemProperties.WithTitle(plan.Properties, plan.Title),
                plan.Schema,
                plan.Views,
                effective) is not null)
            {
                return false;
            }
        }
        ordered = sorted;
        return true;
    }

    private static bool ValidFile(ImportFilePlan? file)
    {
        if (file is null)
        {
            return true;
        }
        return file.SourceKind is "source" or "asset"
            && (file.SourceKind != "asset" || ValidAssetPath(file.AssetPath))
            && file.FileName.Length is > 0 and <= 255
            && file.FileName.IndexOfAny(['/', '\\', '\0']) < 0
            && file.MediaType.Length is > 2 and <= 160
            && file.MediaType.Contains('/', StringComparison.Ordinal)
            && file.ByteLength is >= 0 and <= MaximumFileBytes
            && ValidDigest(file.Sha256)
            && ((file.PixelWidth is null && file.PixelHeight is null)
                || file is { PixelWidth: > 0 and <= 100_000, PixelHeight: > 0 and <= 100_000 }
                    && (long)file.PixelWidth.Value * file.PixelHeight.Value <= 1_000_000_000);
    }

    private static bool ValidSourceId(string? value) =>
        !string.IsNullOrWhiteSpace(value)
        && value.Length <= 160
        && value.All(character => char.IsAsciiLetterOrDigit(character) || character is '.' or '_' or '-' or ':' or '/');

    private static bool ValidAssetPath(string? value)
    {
        if (string.IsNullOrWhiteSpace(value)
            || !ValidSourceId(value)
            || value[0] == '/')
        {
            return false;
        }
        return value.Split('/').All(segment => segment is not ("" or "." or ".."));
    }

    private static bool ValidDigest(string value) =>
        value.Length == 64
        && value.All(character => character is >= '0' and <= '9' or >= 'a' and <= 'f');

    private async ValueTask<DocumentImport?> OwnedTrackingAsync(
        DocumentImportId id,
        CancellationToken cancellationToken)
    {
        var context = Context;
        return await database.DocumentImports.AsTracking().SingleOrDefaultAsync(
            candidate => candidate.TenantId == context.TenantId
                && candidate.ActorId == context.PrincipalId
                && candidate.Id == id,
            cancellationToken).ConfigureAwait(false);
    }

    private async ValueTask<DocumentImportStageRecord?> ReadStageAsync(
        DocumentImport operation,
        CancellationToken cancellationToken)
    {
        if (operation.RootItemId is not { } rootId)
        {
            return null;
        }
        var context = Context;
        var mappings = await database.DocumentImportItems.AsNoTracking()
            .Where(value => value.TenantId == context.TenantId && value.ImportId == operation.Id)
            .OrderBy(value => value.SourceId)
            .ToListAsync(cancellationToken).ConfigureAwait(false);
        return mappings.Count == 0
            ? null
            : new DocumentImportStageRecord(
                operation.Id.Value,
                rootId.Value,
                mappings.Select(ToMapping).ToArray());
    }

    private async ValueTask RebuildClosureAsync(
        IEnumerable<ItemId> itemIds,
        CancellationToken cancellationToken)
    {
        var ids = itemIds.Select(id => id.Value).Distinct().ToArray();
        if (ids.Length == 0)
        {
            return;
        }
        const string sql = """
            WITH RECURSIVE ancestry AS (
                SELECT item.tenant_id, item.workspace_id, item.id AS descendant_id,
                       item.id AS ancestor_id, 0 AS depth
                  FROM item
                 WHERE item.tenant_id = @tenant_id AND item.id = ANY(@item_ids)
                UNION ALL
                SELECT ancestry.tenant_id, ancestry.workspace_id, ancestry.descendant_id,
                       parent.id, ancestry.depth + 1
                  FROM ancestry
                  JOIN item current_item
                    ON current_item.tenant_id = ancestry.tenant_id
                   AND current_item.id = ancestry.ancestor_id
                  JOIN item parent
                    ON parent.tenant_id = current_item.tenant_id
                   AND parent.id = current_item.parent_id
            )
            INSERT INTO item_closure (tenant_id, workspace_id, ancestor_id, descendant_id, depth)
            SELECT tenant_id, workspace_id, ancestor_id, descendant_id, depth FROM ancestry
            ON CONFLICT (ancestor_id, descendant_id) DO NOTHING
            """;
        await database.Database.ExecuteSqlRawAsync(
            sql,
            [
                new NpgsqlParameter("tenant_id", NpgsqlDbType.Uuid) { Value = Context.TenantId.Value },
                new NpgsqlParameter("item_ids", NpgsqlDbType.Array | NpgsqlDbType.Uuid) { Value = ids },
            ],
            cancellationToken).ConfigureAwait(false);
    }

    private NixSessionContext Context => session.Current
        ?? throw new InvalidOperationException("No session context; the pipeline must establish one.");

    private static DocumentImportRecord ToRecord(DocumentImport value) => new(
        value.Id.Value,
        value.WorkspaceId.Value,
        value.UploadId.Value,
        value.ParentId?.Value,
        value.Format,
        value.Title,
        value.Status,
        value.PreviewJobId?.Value,
        value.CommitJobId?.Value,
        value.PlanObjectKey,
        value.PlanSha256,
        value.PlanByteLength,
        value.SourceSha256,
        value.ItemCount,
        value.AssetCount,
        value.Loss,
        value.Omissions,
        value.RootItemId?.Value,
        value.FailureCode,
        value.ExpiresAt,
        value.CompletedAt);

    private static DocumentImportItemMapping ToMapping(DocumentImportItem value) => new(
        value.SourceId,
        value.TargetItemId.Value,
        value.ItemType,
        value.BodyRequired,
        value.ObjectKey,
        value.ObjectReady);
}
