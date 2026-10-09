using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Migrations;
using Microsoft.Extensions.DependencyInjection;
using Nix.Abstractions.Workers;
using Nix.Domain.Identity;
using Nix.Domain.Tenancy;
using Nix.Domain.Workers;
using Nix.Integration.Tests.Harness;
using Nix.Persistence;

namespace Nix.Integration.Tests.Persistence;

[Collection(PostgresCollectionDefinition.Name)]
public sealed class SpeechRetirementMigrationTests(NixPostgresFixture fixture) : IAsyncLifetime
{
    private static CancellationToken Cancellation => TestContext.Current.CancellationToken;

    public async ValueTask InitializeAsync()
    {
        await fixture.ResetAsync();
        await M0SchemaSeed.SeedBothTenantsAsync(fixture);
    }

    public ValueTask DisposeAsync() => ValueTask.CompletedTask;

    [Fact]
    public async Task Upgrade_cancels_only_active_speech_jobs_and_retires_only_pending_speech_commands()
    {
        var options = new DbContextOptionsBuilder<NixDbContext>()
            .UseNpgsql(fixture.MigratorConnectionString).Options;
        await using var context = new NixDbContext(options);
        var migrator = context.GetService<IMigrator>();
        await migrator.MigrateAsync("20261009160000_CliBrowserLogin", Cancellation);
        try
        {
            var before = new DateTimeOffset(2020, 1, 1, 0, 0, 0, TimeSpan.Zero);
            var jobs = new List<WorkerJob>();
            var speechCommands = new List<WorkerOutboxEventId>();
            foreach (var (kind, status, tenant) in new[]
            {
                ("transcribe.audio", "queued", M0SchemaSeed.Alpha),
                ("transcribe.audio", "running", M0SchemaSeed.Alpha),
                ("transcribe.audio", "queued", M0SchemaSeed.Beta),
                ("transcribe.audio", "completed", M0SchemaSeed.Alpha),
                ("transcribe.audio", "failed", M0SchemaSeed.Alpha),
                ("transcribe.audio", "cancelled", M0SchemaSeed.Alpha),
                ("export.docx", "queued", M0SchemaSeed.Alpha),
            })
            {
                var job = new WorkerJob
                {
                    Id = WorkerJobId.Create(),
                    TenantId = TenantId.From(tenant.TenantId),
                    WorkspaceId = WorkspaceId.From(tenant.WorkspaceId),
                    ActorId = PrincipalId.From(tenant.PrincipalId),
                    Kind = kind,
                    IdempotencyKey = Guid.NewGuid().ToString(),
                    Payload = "{}",
                    Result = "{\"preserved\": true}",
                    Status = status,
                    LeaseOwner = status == "running" ? "old-speech-worker" : null,
                    LeaseUntil = status == "running" ? DateTimeOffset.UtcNow.AddHours(1) : null,
                    CompletedAt = status is "completed" or "failed" or "cancelled" ? before : null,
                    CreatedAt = before,
                    UpdatedAt = before,
                };
                jobs.Add(job);
                context.WorkerJobs.Add(job);
                var command = new WorkerOutboxEvent
                {
                    Id = WorkerOutboxEventId.Create(),
                    TenantId = job.TenantId,
                    WorkspaceId = job.WorkspaceId,
                    Kind = "worker.command",
                    Payload = JsonSerializer.Serialize(new { jobId = job.Id.Value, kind }),
                    AvailableAt = before,
                    LeaseOwner = job.LeaseOwner,
                    LeaseUntil = job.LeaseUntil,
                };
                context.WorkerOutboxEvents.Add(command);
                if (kind == "transcribe.audio")
                {
                    speechCommands.Add(command.Id);
                }
            }
            var published = new WorkerOutboxEvent
            {
                Id = WorkerOutboxEventId.Create(),
                TenantId = TenantId.From(M0SchemaSeed.Alpha.TenantId),
                Kind = "worker.command",
                Payload = "{\"kind\": \"transcribe.audio\"}",
                AvailableAt = before,
                ProcessedAt = before,
            };
            var changed = new WorkerOutboxEvent
            {
                Id = WorkerOutboxEventId.Create(),
                TenantId = published.TenantId,
                Kind = "item.changed",
                Payload = published.Payload,
                AvailableAt = before,
            };
            context.WorkerOutboxEvents.AddRange(published, changed);
            await context.SaveChangesAsync(Cancellation);

            var unchangedJobs = jobs.Where(job => job.Kind != "transcribe.audio"
                || job.Status is "completed" or "failed" or "cancelled")
                .ToDictionary(job => job.Id, job => JsonSerializer.Serialize(job));
            var publishedBefore = JsonSerializer.Serialize(await context.WorkerOutboxEvents.AsNoTracking()
                .SingleAsync(row => row.Id == published.Id, Cancellation));
            var changedBefore = JsonSerializer.Serialize(await context.WorkerOutboxEvents.AsNoTracking()
                .SingleAsync(row => row.Id == changed.Id, Cancellation));
            var files = await context.FileVersions.AsNoTracking().OrderBy(file => file.Id).ToListAsync(Cancellation);
            var transcripts = await context.ItemTranscriptions.AsNoTracking().OrderBy(row => row.AudioItemId).ToListAsync(Cancellation);
            Assert.NotEmpty(files);
            Assert.NotEmpty(transcripts);
            var filesBefore = JsonSerializer.Serialize(files);
            var transcriptsBefore = JsonSerializer.Serialize(transcripts);

            await migrator.MigrateAsync(targetMigration: null, cancellationToken: Cancellation);

            foreach (var original in jobs)
            {
                var job = await context.WorkerJobs.AsNoTracking().SingleAsync(row => row.Id == original.Id, Cancellation);
                Assert.Equal(original.Payload, job.Payload);
                Assert.Equal(original.Result, job.Result);
                if (unchangedJobs.TryGetValue(job.Id, out var unchanged))
                {
                    Assert.Equal(unchanged, JsonSerializer.Serialize(job));
                }
                else
                {
                    Assert.Equal("cancelled", job.Status);
                    Assert.True(job.CancellationRequested);
                    Assert.Null(job.LeaseOwner);
                    Assert.Null(job.LeaseUntil);
                    Assert.Equal("job_cancelled", job.ErrorCode);
                    Assert.True(job.CompletedAt > before);
                    Assert.True(job.UpdatedAt > before);
                }
            }
            var retiredCommands = await context.WorkerOutboxEvents.AsNoTracking()
                .Where(row => speechCommands.Contains(row.Id)).ToListAsync(Cancellation);
            Assert.Equal(speechCommands.Count, retiredCommands.Count);
            Assert.All(retiredCommands, command =>
            {
                Assert.True(command.ProcessedAt > before);
                Assert.Null(command.LeaseOwner);
                Assert.Null(command.LeaseUntil);
                Assert.Equal("Speech transcription has been retired.", command.LastError);
            });
            Assert.Equal(publishedBefore, JsonSerializer.Serialize(await context.WorkerOutboxEvents.AsNoTracking()
                .SingleAsync(row => row.Id == published.Id, Cancellation)));
            Assert.Equal(changedBefore, JsonSerializer.Serialize(await context.WorkerOutboxEvents.AsNoTracking()
                .SingleAsync(row => row.Id == changed.Id, Cancellation)));
            Assert.Equal(filesBefore, JsonSerializer.Serialize(await context.FileVersions.AsNoTracking().OrderBy(file => file.Id).ToListAsync(Cancellation)));
            Assert.Equal(transcriptsBefore, JsonSerializer.Serialize(await context.ItemTranscriptions.AsNoTracking().OrderBy(row => row.AudioItemId).ToListAsync(Cancellation)));

            await using var scope = fixture.Application.CreateUnscopedScope();
            var dispatch = scope.ServiceProvider.GetRequiredService<IWorkerDispatchStore>();
            Assert.Empty(await dispatch.LeaseJobsAsync("transcribe.audio", "new-worker", 10, 60, Cancellation));
            var leasedCommand = Assert.Single(await dispatch.LeaseOutboxAsync("worker.command", "publisher", 100, 60, Cancellation));
            using var payload = JsonDocument.Parse(leasedCommand.Payload);
            Assert.Equal("export.docx", payload.RootElement.GetProperty("kind").GetString());
        }
        finally
        {
            await migrator.MigrateAsync(targetMigration: null, cancellationToken: Cancellation);
        }
    }
}
