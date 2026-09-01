using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Nix.Abstractions.Files;
using Nix.Abstractions.Importing;
using Nix.Abstractions.Workers;
using Nix.Domain.Files;
using Nix.Domain.Importing;
using Nix.Domain.Items;
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
