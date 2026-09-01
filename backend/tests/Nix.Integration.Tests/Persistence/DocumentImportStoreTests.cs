using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Nix.Abstractions.Files;
using Nix.Abstractions.Importing;
using Nix.Abstractions.Templates;
using Nix.Abstractions.Workers;
using Nix.Domain.Files;
using Nix.Domain.Importing;
using Nix.Domain.Items;
using Nix.Domain.Templates;
using Nix.Domain.Tenancy;
using Nix.Integration.Tests.Harness;
using Nix.Persistence.ObjectStorage;
using Npgsql;

namespace Nix.Integration.Tests.Persistence;

/// <summary>Document imports stay hidden until their complete staged subtree can publish.</summary>
[Collection(PostgresCollectionDefinition.Name)]
public sealed class DocumentImportStoreTests(NixPostgresFixture fixture) : IAsyncLifetime
{
    private static CancellationToken Cancellation => TestContext.Current.CancellationToken;

    public async ValueTask InitializeAsync()
    {
        await fixture.ResetAsync();
        await M0SchemaSeed.SeedBothTenantsAsync(fixture);
    }

    public ValueTask DisposeAsync() => ValueTask.CompletedTask;

    [Fact]
    public async Task A_complete_txt_plan_publishes_the_note_and_retained_source_atomically()
    {
        DocumentImportRecord operation;
        DocumentImportStageRecord stage;
        await using (var work = await fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation))
        {
            var prepared = await CommitQueuedAsync(work, "txt", "source.txt", 4);
            var imports = prepared.Store;
            operation = prepared.Operation;
            var root = new ImportEnvelopePlan(
                "root",
                ParentSourceId: null,
                Order: 0,
                "Imported note",
                "note",
                Properties: null,
                Schema: null,
                Views: null,
                FinalLifecycleState: "active",
                BodyRequired: true,
                File: null);
            var original = new ImportEnvelopePlan(
                "original",
                "root",
                Order: 0,
                "source.txt",
                "file",
                Properties: null,
                Schema: null,
                Views: null,
                FinalLifecycleState: "active",
                BodyRequired: false,
                new ImportFilePlan(
                    "source",
                    AssetPath: null,
                    "source.txt",
                    "text/plain",
                    4,
                    prepared.SourceDigest,
                    Previewable: false,
                    PixelWidth: null,
                    PixelHeight: null));

            stage = Assert.IsType<DocumentImportStageRecord>(await imports.StageAsync(
                new StageDocumentImport(
                    DocumentImportId.From(operation.Id),
                    new string('b', 64),
                    prepared.SourceDigest,
                    [root, original]),
                Cancellation));

            Assert.False(await work.DbContext.Items.AnyAsync(
                item => item.Id == ItemId.From(stage.RootItemId),
                Cancellation));
            Assert.Equal(2, await work.DbContext.Items.IgnoreQueryFilters().CountAsync(
                item => stage.Items.Select(mapping => ItemId.From(mapping.TargetItemId)).Contains(item.Id),
                Cancellation));
            Assert.Null(await imports.FinalizeAsync(DocumentImportId.From(operation.Id), Cancellation));
            Assert.True(await imports.MarkObjectReadyAsync(
                DocumentImportId.From(operation.Id),
                "original",
                4,
                prepared.SourceDigest,
                Cancellation));
            await work.CommitAsync(Cancellation);
        }

        await WriteCollaborationBodyAsync(stage.RootItemId);

        await using (var publish = await fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation))
        {
            var completed = Assert.IsType<DocumentImportRecord>(await publish.Resolve<IDocumentImportStore>().FinalizeAsync(
                DocumentImportId.From(operation.Id),
                Cancellation));

            Assert.Equal(DocumentImportStatuses.Completed, completed.Status);
            Assert.Equal(stage.RootItemId, completed.RootItemId);
            Assert.Equal(2, await publish.DbContext.Items.CountAsync(
                item => stage.Items.Select(mapping => ItemId.From(mapping.TargetItemId)).Contains(item.Id),
                Cancellation));
            var importedItemIds = stage.Items
                .Select(mapping => ItemId.From(mapping.TargetItemId))
                .ToArray();
            var indexEvents = await publish.DbContext.WorkerOutboxEvents
                .Where(value => value.ItemId != null && importedItemIds.Contains(value.ItemId.Value))
                .Select(value => new { value.ItemId, value.Kind })
                .ToListAsync(Cancellation);

            Assert.Equal(2, indexEvents.Count);
            Assert.All(indexEvents, value => Assert.Equal("item.changed", value.Kind));
            Assert.Single(indexEvents, value => value.ItemId == ItemId.From(stage.RootItemId));
            var sourceItemId = ItemId.From(stage.Items.Single(mapping => mapping.SourceId == "original").TargetItemId);
            Assert.Single(indexEvents, value => value.ItemId == sourceItemId);
        }
    }

    [Fact]
    public async Task A_plan_cannot_substitute_or_omit_the_declared_source_file()
    {
        await using var work = await fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        var (imports, operation, digest) = await CommitQueuedAsync(work, "txt", "source.txt", 4);
        var root = new ImportEnvelopePlan(
            "root", null, 0, "Imported", "note", null, null, null, "active", BodyRequired: true, File: null);
        var substituted = new ImportEnvelopePlan(
            "original", "root", 0, "other.txt", "file", null, null, null, "active", BodyRequired: false,
            new ImportFilePlan("source", null, "other.txt", "text/plain", 4, digest, false, null, null));

        Assert.Null(await imports.StageAsync(
            new StageDocumentImport(
                DocumentImportId.From(operation.Id),
                new string('b', 64),
                digest,
                [root]),
            Cancellation));
        Assert.Null(await imports.StageAsync(
            new StageDocumentImport(
                DocumentImportId.From(operation.Id),
                new string('b', 64),
                digest,
                [root, substituted]),
            Cancellation));
        Assert.False(await work.DbContext.Items.IgnoreQueryFilters().AnyAsync(
            item => item.LifecycleState == ItemLifecycleState.Provisioning,
            Cancellation));
    }

    [Fact]
    public async Task A_failed_commit_removes_every_staged_envelope_and_file_version()
    {
        await using var work = await fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        var (imports, operation, digest) = await CommitQueuedAsync(work, "txt", "source.txt", 4);
        var root = new ImportEnvelopePlan(
            "root", null, 0, "Imported", "note", null, null, null, "active", BodyRequired: true, File: null);
        var original = new ImportEnvelopePlan(
            "original", "root", 0, "source.txt", "file", null, null, null, "active", BodyRequired: false,
            new ImportFilePlan("source", null, "source.txt", "text/plain", 4, digest, false, null, null));
        var stage = Assert.IsType<DocumentImportStageRecord>(await imports.StageAsync(
            new StageDocumentImport(
                DocumentImportId.From(operation.Id),
                new string('b', 64),
                digest,
                [root, original]),
            Cancellation));

        var cleanup = Assert.IsType<DocumentImportCleanupRecord>(await imports.FailAsync(
            DocumentImportId.From(operation.Id),
            "import_body_invalid",
            Cancellation));
        Assert.Contains(cleanup.ObjectKeys, key => key.Contains("files/versions/", StringComparison.Ordinal));

        var targetIds = stage.Items.Select(mapping => ItemId.From(mapping.TargetItemId)).ToArray();
        Assert.False(await work.DbContext.Items.IgnoreQueryFilters().AnyAsync(
            item => targetIds.Contains(item.Id),
            Cancellation));
        Assert.False(await work.DbContext.FileVersions.AnyAsync(
            version => targetIds.Contains(version.ItemId),
            Cancellation));
    }

    [Fact]
    public async Task An_expired_staged_import_is_removed_and_every_object_is_queued_for_cleanup()
    {
        Guid importId;
        Guid[] targetIds;
        await using (var work = await fixture.Application.BeginUnitOfWorkAsync(
            TestTenants.AlphaContext,
            Cancellation))
        {
            var (imports, operation, digest) = await CommitQueuedAsync(
                work,
                "txt",
                "expired.txt",
                4);
            var root = new ImportEnvelopePlan(
                "root", null, 0, "Expired", "note", null, null, null, "active", true, null);
            var source = new ImportEnvelopePlan(
                "source", "root", 0, "expired.txt", "file", null, null, null, "active", false,
                new ImportFilePlan("source", null, "expired.txt", "text/plain", 4, digest, false, null, null));
            var stage = Assert.IsType<DocumentImportStageRecord>(await imports.StageAsync(
                new StageDocumentImport(DocumentImportId.From(operation.Id), new string('b', 64), digest, [root, source]),
                Cancellation));
            importId = operation.Id;
            targetIds = stage.Items.Select(value => value.TargetItemId).ToArray();
            await work.CommitAsync(Cancellation);
        }

        var connection = await fixture.OpenMigratorConnectionAsync();
        await using (connection.ConfigureAwait(false))
        {
            var command = new NpgsqlCommand(
                "UPDATE document_import SET expires_at = now() - interval '1 minute' WHERE import_id = @import_id",
                connection);
            await using (command.ConfigureAwait(false))
            {
                command.Parameters.AddWithValue("import_id", importId);
                await command.ExecuteNonQueryAsync(Cancellation);
            }
        }

        await using (var scope = fixture.Application.CreateUnscopedScope())
        {
            Assert.Equal(1, await scope.ServiceProvider
                .GetRequiredService<AbandonedObjectReaper>()
                .ReapOnceAsync(Cancellation));
        }

        await using var verify = await fixture.Application.BeginUnitOfWorkAsync(
            TestTenants.AlphaContext,
            Cancellation);
        var operationRecord = Assert.IsType<DocumentImportRecord>(await verify
            .Resolve<IDocumentImportStore>()
            .GetAsync(DocumentImportId.From(importId), Cancellation));
        Assert.Equal(DocumentImportStatuses.Failed, operationRecord.Status);
        Assert.Equal("import_expired", operationRecord.FailureCode);
        Assert.False(await verify.DbContext.Items.IgnoreQueryFilters()
            .AnyAsync(value => targetIds.Select(ItemId.From).Contains(value.Id), Cancellation));
        var cleanupJob = await verify.DbContext.WorkerJobs.SingleAsync(
            job => job.Kind == "object.cleanup"
                && job.IdempotencyKey == $"object.cleanup:document-import:{importId:D}",
            Cancellation);
        using var payload = JsonDocument.Parse(cleanupJob.Payload);
        var keys = payload.RootElement.GetProperty("objectKeys")
            .EnumerateArray()
            .Select(value => value.GetString())
            .ToArray();
        Assert.Equal(3, keys.Length);
        Assert.Contains(keys, key => key is not null && key.StartsWith("files/uploads/", StringComparison.Ordinal));
        Assert.Contains(keys, key => key is not null && key.StartsWith("files/versions/", StringComparison.Ordinal));
        Assert.Contains(keys, key => key is not null && key.StartsWith("imports/plans/", StringComparison.Ordinal));
    }

    [Fact]
    public async Task Cancellation_and_finalization_never_publish_a_partial_subtree()
    {
        DocumentImportStageRecord stage;
        Guid importId;
        await using (var prepare = await fixture.Application.BeginUnitOfWorkAsync(
            TestTenants.AlphaContext,
            Cancellation))
        {
            var (imports, operation, digest) = await CommitQueuedAsync(prepare, "markdown", "race.md", 4);
            var root = new ImportEnvelopePlan(
                "root", null, 0, "Race", "note", null, null, null, "active", true, null);
            var child = new ImportEnvelopePlan(
                "child", "root", 0, "Child", "note", null, null, null, "active", false, null);
            stage = Assert.IsType<DocumentImportStageRecord>(await imports.StageAsync(
                new StageDocumentImport(DocumentImportId.From(operation.Id), new string('b', 64), digest, [root, child]),
                Cancellation));
            importId = operation.Id;
            await prepare.CommitAsync(Cancellation);
        }
        await WriteCollaborationBodyAsync(stage.RootItemId);

        async Task<DocumentImportRecord?> FinalizeAsync()
        {
            await using var work = await fixture.Application.BeginUnitOfWorkAsync(
                TestTenants.AlphaContext,
                Cancellation);
            var result = await work.Resolve<IDocumentImportStore>()
                .FinalizeAsync(DocumentImportId.From(importId), Cancellation);
            await work.CommitAsync(Cancellation);
            return result;
        }

        async Task<DocumentImportCleanupRecord?> CancelAsync()
        {
            await using var work = await fixture.Application.BeginUnitOfWorkAsync(
                TestTenants.AlphaContext,
                Cancellation);
            var result = await work.Resolve<IDocumentImportStore>()
                .CancelAsync(DocumentImportId.From(importId), Cancellation);
            await work.CommitAsync(Cancellation);
            return result;
        }

        var finalizeTask = FinalizeAsync();
        var cancelTask = CancelAsync();
        await Task.WhenAll(finalizeTask, cancelTask);
        var finalized = await finalizeTask;
        var cancelled = await cancelTask;
        await using var verify = await fixture.Application.BeginUnitOfWorkAsync(
            TestTenants.AlphaContext,
            Cancellation);
        var verifiedOperation = Assert.IsType<DocumentImportRecord>(await verify.Resolve<IDocumentImportStore>()
            .GetAsync(DocumentImportId.From(importId), Cancellation));
        var persistedTargets = await verify.DbContext.Items.IgnoreQueryFilters().CountAsync(
            value => stage.Items.Select(mapping => ItemId.From(mapping.TargetItemId)).Contains(value.Id),
            Cancellation);
        if (verifiedOperation.Status == DocumentImportStatuses.Completed)
        {
            Assert.NotNull(finalized);
            Assert.Null(cancelled);
            Assert.Equal(stage.Items.Count, persistedTargets);
        }
        else
        {
            Assert.Equal(DocumentImportStatuses.Cancelled, verifiedOperation.Status);
            Assert.Null(finalized);
            Assert.NotNull(cancelled);
            Assert.Equal(0, persistedTargets);
        }
    }

    [Fact]
    public async Task A_template_attempt_tracks_its_hidden_stage_until_the_catalog_is_published()
    {
        await using var work = await fixture.Application.BeginUnitOfWorkAsync(
            TestTenants.AlphaContext,
            Cancellation);
        var files = work.Resolve<IFileStore>();
        var imports = work.Resolve<IDocumentImportStore>();
        var jobs = work.Resolve<IWorkerJobStore>();
        var templates = work.Resolve<ITemplateStagingStore>();
        var templateCatalog = work.Resolve<ITemplateCatalogStore>();
        var digest = new string('a', 64);
        var upload = Assert.IsType<FileUploadRecord>(await files.BeginAsync(
            new BeginFileUpload(
                WorkspaceId.From(M0SchemaSeed.Alpha.WorkspaceId),
                ParentId: null,
                TargetItemId: null,
                "portable.nix",
                "application/zip",
                128,
                "template-archive-attempt",
                FileUploadPurposes.TemplateImport),
            Cancellation));
        var attempt = Assert.IsType<DocumentImportRecord>(await imports.BeginAsync(
            new BeginDocumentImport(
                WorkspaceId.From(M0SchemaSeed.Alpha.WorkspaceId),
                ParentId: null,
                FileUploadId.From(upload.Id),
                "nix",
                "portable.nix",
                "template-archive-attempt",
                DocumentImportPurposes.TemplateUser),
            Cancellation));
        var previewJob = await jobs.CreateAsync(
            TenantId.From(M0SchemaSeed.Alpha.TenantId),
            Nix.Domain.Identity.PrincipalId.From(M0SchemaSeed.Alpha.PrincipalId),
            WorkspaceId.From(M0SchemaSeed.Alpha.WorkspaceId),
            "template.preview",
            "template-preview-attempt",
            "{}",
            Cancellation);
        Assert.NotNull(await imports.AttachPreviewJobAsync(
            DocumentImportId.From(attempt.Id),
            Nix.Domain.Workers.WorkerJobId.From(previewJob.Id),
            Cancellation));
        Assert.NotNull(await imports.CompletePreviewAsync(
            new CompleteDocumentImportPreview(
                DocumentImportId.From(attempt.Id),
                new string('b', 64),
                PlanByteLength: 256,
                digest,
                ItemCount: 1,
                AssetCount: 0,
                "[]",
                "[]",
                "{\"profile\":{\"kind\":\"template\"}}"),
            Cancellation));
        var commitJob = await jobs.CreateAsync(
            TenantId.From(M0SchemaSeed.Alpha.TenantId),
            Nix.Domain.Identity.PrincipalId.From(M0SchemaSeed.Alpha.PrincipalId),
            WorkspaceId.From(M0SchemaSeed.Alpha.WorkspaceId),
            "template.commit",
            "template-commit-attempt",
            "{}",
            Cancellation);
        Assert.NotNull(await imports.AttachCommitJobAsync(
            DocumentImportId.From(attempt.Id),
            Nix.Domain.Workers.WorkerJobId.From(commitJob.Id),
            Cancellation));

        var sourceId = Guid.NewGuid();
        var stagedResult = await templates.BeginImportAsync(
            WorkspaceId.From(M0SchemaSeed.Alpha.WorkspaceId),
            "template-archive-attempt",
            new TemplateImportDescriptor(
                "portable-template",
                "Portable template",
                null,
                TemplateOrigin.User,
                null,
                digest,
                IncludeBody: false,
                IncludeChildren: false),
            [new TemplateImportItem(sourceId, null, "note", "Portable template", 1024, null, null, null, false)],
            Cancellation);
        Assert.True(stagedResult.IsSuccess, stagedResult.Error.Message);
        var staged = stagedResult.Value;
        var stagingAttempt = Assert.IsType<DocumentImportRecord>(await imports.AttachTemplateStageAsync(
            new AttachTemplateImportStage(
                DocumentImportId.From(attempt.Id),
                staged.OperationId,
                staged.TemplateId,
                "portable-template",
                digest,
                staged.Unchanged),
            Cancellation));
        Assert.Equal(DocumentImportStatuses.Staging, stagingAttempt.Status);
        Assert.Equal(staged.OperationId?.Value, stagingAttempt.TemplateOperationId);

        if (staged.OperationId is { } operationId)
        {
            var finalized = await templates.FinalizeOperationAsync(operationId, [], Cancellation);
            Assert.True(finalized.IsSuccess, finalized.Error.Message);
        }
        var completed = Assert.IsType<DocumentImportRecord>(await imports.CompleteTemplateAsync(
            new CompleteTemplateImport(DocumentImportId.From(attempt.Id), [], Managed: false),
            Cancellation));
        Assert.Equal(DocumentImportStatuses.Completed, completed.Status);
        Assert.Equal(staged.TemplateId.Value, completed.TemplateId);
        Assert.Equal("portable-template", completed.TemplateStableKey);
        Assert.Equal(digest, completed.TemplateDigest);
        Assert.Equal("[]", completed.TemplateWrittenTargetItemIds);

        var deleted = await templateCatalog.DeleteAsync(staged.TemplateId, Cancellation);
        Assert.True(deleted.IsSuccess, deleted.Error.Message);
        Assert.False(await work.DbContext.WorkspaceTemplates.AnyAsync(
            template => template.Id == staged.TemplateId,
            Cancellation));
        var retainedHistory = Assert.IsType<DocumentImportRecord>(await imports.GetAsync(
            DocumentImportId.From(attempt.Id),
            Cancellation));
        Assert.Equal(staged.TemplateId.Value, retainedHistory.TemplateId);
    }

    [Fact]
    public async Task Expiry_reaps_a_linked_template_stage_even_after_the_actor_is_suspended()
    {
        DocumentImportRecord attempt;
        TemplateImportPlan stage;
        await using (var work = await fixture.Application.BeginUnitOfWorkAsync(
            TestTenants.AlphaContext,
            Cancellation))
        {
            (attempt, stage) = await PrepareTemplateStageAsync(work, "expired-template-stage");
            await work.CommitAsync(Cancellation);
        }

        var connection = await fixture.OpenMigratorConnectionAsync();
        await using (connection.ConfigureAwait(false))
        {
            var command = new NpgsqlCommand(
                """
                UPDATE document_import
                   SET expires_at = now() - interval '1 minute'
                 WHERE import_id = @import_id;
                UPDATE principal
                   SET status = 'suspended'
                 WHERE tenant_id = @tenant_id
                   AND principal_id = @principal_id;
                """,
                connection);
            await using (command.ConfigureAwait(false))
            {
                command.Parameters.AddWithValue("import_id", attempt.Id);
                command.Parameters.AddWithValue("tenant_id", M0SchemaSeed.Alpha.TenantId);
                command.Parameters.AddWithValue("principal_id", M0SchemaSeed.Alpha.PrincipalId);
                await command.ExecuteNonQueryAsync(Cancellation);
            }
        }

        await using (var scope = fixture.Application.CreateUnscopedScope())
        {
            Assert.Equal(1, await scope.ServiceProvider
                .GetRequiredService<AbandonedObjectReaper>()
                .ReapOnceAsync(Cancellation));
        }

        await using var verify = await fixture.Application.BeginUnitOfWorkAsync(
            TestTenants.AlphaContext,
            Cancellation);
        var durable = Assert.IsType<DocumentImportRecord>(await verify.Resolve<IDocumentImportStore>()
            .GetAsync(DocumentImportId.From(attempt.Id), Cancellation));
        Assert.Equal(DocumentImportStatuses.Failed, durable.Status);
        Assert.Equal("import_expired", durable.FailureCode);
        Assert.False(await verify.DbContext.TemplateOperations.AnyAsync(
            value => value.Id == stage.OperationId,
            Cancellation));
        var targets = stage.ItemMappings.Select(value => value.ItemId).ToArray();
        Assert.False(await verify.DbContext.Items.IgnoreQueryFilters().AnyAsync(
            value => targets.Contains(value.Id),
            Cancellation));
        Assert.False(await verify.DbContext.WorkspaceTemplates.AnyAsync(
            value => value.Id == stage.TemplateId,
            Cancellation));
        Assert.Single(await verify.DbContext.WorkerJobs.Where(
            job => job.Kind == "object.cleanup"
                && job.IdempotencyKey == $"object.cleanup:document-import:{attempt.Id:D}")
            .ToListAsync(Cancellation));
    }

    [Fact]
    public async Task Import_operations_never_cross_tenants()
    {
        Guid betaImportId;
        await using (var beta = await fixture.Application.BeginUnitOfWorkAsync(TestTenants.BetaContext, Cancellation))
        {
            var upload = Assert.IsType<FileUploadRecord>(await beta.Resolve<IFileStore>().BeginAsync(
                new BeginFileUpload(
                    WorkspaceId.From(M0SchemaSeed.Beta.WorkspaceId),
                    ParentId: null,
                    TargetItemId: null,
                    "source.txt",
                    "text/plain",
                    4,
                    "beta-import",
                    FileUploadPurposes.DocumentImport),
                Cancellation));
            var operation = Assert.IsType<DocumentImportRecord>(await beta.Resolve<IDocumentImportStore>().BeginAsync(
                new BeginDocumentImport(
                    WorkspaceId.From(M0SchemaSeed.Beta.WorkspaceId),
                    ParentId: null,
                    FileUploadId.From(upload.Id),
                    "txt",
                    "Beta import",
                    "beta-import"),
                Cancellation));
            betaImportId = operation.Id;
            await beta.CommitAsync(Cancellation);
        }

        await using var alpha = await fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        Assert.Null(await alpha.Resolve<IDocumentImportStore>().GetAsync(
            DocumentImportId.From(betaImportId),
            Cancellation));
    }

    private static async Task<(IDocumentImportStore Store, DocumentImportRecord Operation, string SourceDigest)> CommitQueuedAsync(
        NixUnitOfWork work,
        string format,
        string fileName,
        long bytes)
    {
        var files = work.Resolve<IFileStore>();
        var imports = work.Resolve<IDocumentImportStore>();
        var jobs = work.Resolve<IWorkerJobStore>();
        var digest = new string('a', 64);
        var upload = Assert.IsType<FileUploadRecord>(await files.BeginAsync(
            new BeginFileUpload(
                WorkspaceId.From(M0SchemaSeed.Alpha.WorkspaceId),
                ParentId: null,
                TargetItemId: null,
                fileName,
                "text/plain",
                bytes,
                $"{format}-document-import",
                FileUploadPurposes.DocumentImport),
            Cancellation));
        var operation = Assert.IsType<DocumentImportRecord>(await imports.BeginAsync(
            new BeginDocumentImport(
                WorkspaceId.From(M0SchemaSeed.Alpha.WorkspaceId),
                ParentId: null,
                FileUploadId.From(upload.Id),
                format,
                "Imported note",
                $"{format}-document-import"),
            Cancellation));
        var previewJob = await jobs.CreateAsync(
            TenantId.From(M0SchemaSeed.Alpha.TenantId),
            Nix.Domain.Identity.PrincipalId.From(M0SchemaSeed.Alpha.PrincipalId),
            WorkspaceId.From(M0SchemaSeed.Alpha.WorkspaceId),
            $"import.preview.{format}",
            $"preview-{format}",
            "{}",
            Cancellation);
        Assert.NotNull(await imports.AttachPreviewJobAsync(
            DocumentImportId.From(operation.Id),
            Nix.Domain.Workers.WorkerJobId.From(previewJob.Id),
            Cancellation));
        Assert.NotNull(await imports.CompletePreviewAsync(
            new CompleteDocumentImportPreview(
                DocumentImportId.From(operation.Id),
                new string('b', 64),
                PlanByteLength: 100,
                digest,
                ItemCount: 2,
                AssetCount: 0,
                "[]",
                "[]"),
            Cancellation));
        var commitJob = await jobs.CreateAsync(
            TenantId.From(M0SchemaSeed.Alpha.TenantId),
            Nix.Domain.Identity.PrincipalId.From(M0SchemaSeed.Alpha.PrincipalId),
            WorkspaceId.From(M0SchemaSeed.Alpha.WorkspaceId),
            "import.commit",
            $"commit-{format}",
            "{}",
            Cancellation);
        operation = Assert.IsType<DocumentImportRecord>(await imports.AttachCommitJobAsync(
            DocumentImportId.From(operation.Id),
            Nix.Domain.Workers.WorkerJobId.From(commitJob.Id),
            Cancellation));
        return (imports, operation, digest);
    }

    private static async Task<(DocumentImportRecord Attempt, TemplateImportPlan Stage)> PrepareTemplateStageAsync(
        NixUnitOfWork work,
        string idempotencyKey)
    {
        var files = work.Resolve<IFileStore>();
        var imports = work.Resolve<IDocumentImportStore>();
        var jobs = work.Resolve<IWorkerJobStore>();
        var templates = work.Resolve<ITemplateStagingStore>();
        var digest = new string('a', 64);
        var upload = Assert.IsType<FileUploadRecord>(await files.BeginAsync(
            new BeginFileUpload(
                WorkspaceId.From(M0SchemaSeed.Alpha.WorkspaceId),
                ParentId: null,
                TargetItemId: null,
                "expired.nix",
                "application/zip",
                128,
                idempotencyKey,
                FileUploadPurposes.TemplateImport),
            Cancellation));
        var attempt = Assert.IsType<DocumentImportRecord>(await imports.BeginAsync(
            new BeginDocumentImport(
                WorkspaceId.From(M0SchemaSeed.Alpha.WorkspaceId),
                ParentId: null,
                FileUploadId.From(upload.Id),
                "nix",
                "expired.nix",
                idempotencyKey,
                DocumentImportPurposes.TemplateUser),
            Cancellation));
        var preview = await jobs.CreateAsync(
            TenantId.From(M0SchemaSeed.Alpha.TenantId),
            Nix.Domain.Identity.PrincipalId.From(M0SchemaSeed.Alpha.PrincipalId),
            WorkspaceId.From(M0SchemaSeed.Alpha.WorkspaceId),
            "template.preview",
            $"{idempotencyKey}:preview",
            "{}",
            Cancellation);
        Assert.NotNull(await imports.AttachPreviewJobAsync(
            DocumentImportId.From(attempt.Id),
            Nix.Domain.Workers.WorkerJobId.From(preview.Id),
            Cancellation));
        Assert.NotNull(await imports.CompletePreviewAsync(
            new CompleteDocumentImportPreview(
                DocumentImportId.From(attempt.Id),
                new string('b', 64),
                PlanByteLength: 256,
                digest,
                ItemCount: 1,
                AssetCount: 0,
                "[]",
                "[]",
                "{\"profile\":{\"kind\":\"template\"}}"),
            Cancellation));
        var commit = await jobs.CreateAsync(
            TenantId.From(M0SchemaSeed.Alpha.TenantId),
            Nix.Domain.Identity.PrincipalId.From(M0SchemaSeed.Alpha.PrincipalId),
            WorkspaceId.From(M0SchemaSeed.Alpha.WorkspaceId),
            "template.commit",
            $"{idempotencyKey}:commit",
            "{}",
            Cancellation);
        Assert.NotNull(await imports.AttachCommitJobAsync(
            DocumentImportId.From(attempt.Id),
            Nix.Domain.Workers.WorkerJobId.From(commit.Id),
            Cancellation));
        var sourceId = Guid.NewGuid();
        var staged = await templates.BeginImportAsync(
            WorkspaceId.From(M0SchemaSeed.Alpha.WorkspaceId),
            idempotencyKey,
            new TemplateImportDescriptor(
                idempotencyKey,
                "Expired template",
                null,
                TemplateOrigin.User,
                null,
                digest,
                IncludeBody: false,
                IncludeChildren: false),
            [new TemplateImportItem(sourceId, null, "note", "Expired", 1024, null, null, null, false)],
            Cancellation);
        Assert.True(staged.IsSuccess, staged.Error.Message);
        attempt = Assert.IsType<DocumentImportRecord>(await imports.AttachTemplateStageAsync(
            new AttachTemplateImportStage(
                DocumentImportId.From(attempt.Id),
                staged.Value.OperationId,
                staged.Value.TemplateId,
                idempotencyKey,
                digest,
                staged.Value.Unchanged),
            Cancellation));
        return (attempt, staged.Value);
    }

    private async Task WriteCollaborationBodyAsync(Guid itemId)
    {
        var connectionString = new NpgsqlConnectionStringBuilder(fixture.ApplicationConnectionString)
        {
            Username = NixDatabaseRoles.Collaboration,
            Password = NixDatabaseRoles.Password,
        }.ConnectionString;
        await using var connection = new NpgsqlConnection(connectionString);
        await connection.OpenAsync(Cancellation);
        await using var transaction = await connection.BeginTransactionAsync(Cancellation);
        var command = new NpgsqlCommand(
            """
            SELECT set_config('nix.tenant_id', @tenant_id::text, true),
                   set_config('nix.principal_id', @principal_id::text, true);
            INSERT INTO content_doc
                (doc_id, tenant_id, item_id, workspace_id, schema_version, head_seq, created_at)
            VALUES (@doc_id, @tenant_id, @item_id, @workspace_id, 2, 1, now());
            """,
            connection,
            transaction);
        await using (command.ConfigureAwait(false))
        {
            command.Parameters.AddWithValue("doc_id", Guid.NewGuid());
            command.Parameters.AddWithValue("tenant_id", M0SchemaSeed.Alpha.TenantId);
            command.Parameters.AddWithValue("principal_id", M0SchemaSeed.Alpha.PrincipalId);
            command.Parameters.AddWithValue("item_id", itemId);
            command.Parameters.AddWithValue("workspace_id", M0SchemaSeed.Alpha.WorkspaceId);
            await command.ExecuteNonQueryAsync(Cancellation);
        }
        await transaction.CommitAsync(Cancellation);
    }
}
