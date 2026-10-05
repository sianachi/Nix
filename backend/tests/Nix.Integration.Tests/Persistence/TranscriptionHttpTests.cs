using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Security.Cryptography;
using System.Text.Json;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Extensions.DependencyInjection;
using Nix.Abstractions;
using Nix.Abstractions.Files;
using Nix.Abstractions.Transcriptions;
using Nix.Abstractions.Workers;
using Nix.Authentication;
using Nix.Domain.Files;
using Nix.Domain.Identity;
using Nix.Domain.Items;
using Nix.Domain.Tenancy;
using Nix.Domain.Workers;
using Nix.Features.Items;
using Nix.Features.Tokens;
using Nix.Integration.Tests.Harness;
using Nix.Messaging;
using Nix.Persistence.Workers;

namespace Nix.Integration.Tests.Persistence;

/// <summary>
/// Meeting transcription (ADR-0059) through the real pipeline: tokens exchanged, the unit-of-work
/// and worker-execution middleware deciding who is asking, and real Postgres behind both.
/// </summary>
[Collection(PostgresCollectionDefinition.Name)]
public sealed class TranscriptionHttpTests : IAsyncLifetime
{
    private const string InternalSecret = "transcription-http-internal-secret";
    private const string Execution = "speech-worker:0199a0d1-fbc1-7d99-9ce7-1c721b406ff0";

    /// <summary>A second principal in tenant Alpha, with no tenant role: only what membership grants.</summary>
    private static readonly Guid Colleague = new("1c0c1c0c-1111-4111-8111-1c0c1c0c1c0c");

    private readonly NixPostgresFixture _fixture;
    private WebApplicationFactory<Program> _factory = null!;
    private HttpClient _client = null!;

    public TranscriptionHttpTests(NixPostgresFixture fixture) => _fixture = fixture;

    private static CancellationToken Cancellation => TestContext.Current.CancellationToken;

    public async ValueTask InitializeAsync()
    {
        await _fixture.ResetAsync();
        await M0SchemaSeed.SeedBothTenantsAsync(_fixture);
        _factory = CreateFactory(withObjectStorage: true);
        _client = _factory.CreateClient();
    }

    public async ValueTask DisposeAsync()
    {
        _client.Dispose();
        await _factory.DisposeAsync();
    }

    [Fact]
    public async Task Starting_creates_one_job_with_the_recording_and_its_note_and_answers_accepted()
    {
        var note = await CreateItemAsync("note", "Weekly sync", M0SchemaSeed.Alpha.ItemId);
        var audio = await CreateFileAsync("weekly-sync.weba", "audio/webm", note);
        var token = await AccessTokenAsync(TestTenants.AlphaContext);

        using var start = await SendAsync(HttpMethod.Post, Route(audio), token, new { speakers = "channels" });

        Assert.Equal(HttpStatusCode.Accepted, start.StatusCode);
        Assert.Equal($"/api/v1/items/{audio:D}/transcription", start.Headers.Location?.OriginalString);
        using var body = JsonDocument.Parse(await start.Content.ReadAsStringAsync(Cancellation));
        var root = body.RootElement;
        Assert.Equal(audio, root.GetProperty("audioItemId").GetGuid());
        Assert.Equal(note, root.GetProperty("noteItemId").GetGuid());
        Assert.Equal("queued", root.GetProperty("status").GetString());
        Assert.Equal(0, root.GetProperty("progress").GetInt32());
        Assert.Equal("channels", root.GetProperty("speakers").GetString());
        Assert.Equal(JsonValueKind.Null, root.GetProperty("errorCode").ValueKind);
        Assert.Equal(JsonValueKind.Null, root.GetProperty("completedAt").ValueKind);
        Assert.False(root.TryGetProperty("errorDetail", out _));
        var jobId = root.GetProperty("operationId").GetGuid();

        var jobs = await TranscriptionJobsAsync();
        var job = Assert.Single(jobs);
        Assert.Equal(jobId, job.Id);
        Assert.Equal("transcribe.audio", job.Kind);
        Assert.Equal(TestTenants.AlphaWorkspace, job.WorkspaceId);
        Assert.Equal(TestTenants.AlphaPrincipal, job.ActorId);
        using var payload = JsonDocument.Parse(job.Payload);
        Assert.Equal(3, payload.RootElement.EnumerateObject().Count());
        Assert.Equal(audio, payload.RootElement.GetProperty("audioItemId").GetGuid());
        Assert.Equal(note, payload.RootElement.GetProperty("noteItemId").GetGuid());
        Assert.Equal("channels", payload.RootElement.GetProperty("speakers").GetString());

        // The job is an ordinary operation to the principal who started it.
        using var operation = await SendAsync(HttpMethod.Get, $"/api/v1/operations/{jobId:D}", token);
        Assert.Equal(HttpStatusCode.OK, operation.StatusCode);
    }

    [Fact]
    public async Task Starting_again_while_queued_or_running_returns_the_same_job_unchanged()
    {
        var (audio, _) = await CreateRecordingAsync();
        var token = await AccessTokenAsync(TestTenants.AlphaContext);
        var first = await StartAsync(audio, token, "none");

        // Queued, and asking for a different mode: still the job that exists.
        using (var again = await SendAsync(HttpMethod.Post, Route(audio), token, new { speakers = "channels" }))
        {
            Assert.Equal(HttpStatusCode.Accepted, again.StatusCode);
            using var body = JsonDocument.Parse(await again.Content.ReadAsStringAsync(Cancellation));
            Assert.Equal(first, body.RootElement.GetProperty("operationId").GetGuid());
            Assert.Equal("none", body.RootElement.GetProperty("speakers").GetString());
            Assert.Equal("queued", body.RootElement.GetProperty("status").GetString());
        }

        await ClaimAsync(first);
        using (var running = await SendAsync(HttpMethod.Post, Route(audio), token, new { speakers = "none" }))
        {
            Assert.Equal(HttpStatusCode.Accepted, running.StatusCode);
            using var body = JsonDocument.Parse(await running.Content.ReadAsStringAsync(Cancellation));
            Assert.Equal(first, body.RootElement.GetProperty("operationId").GetGuid());
            Assert.Equal("running", body.RootElement.GetProperty("status").GetString());
        }

        Assert.Single(await TranscriptionJobsAsync());
    }

    [Fact]
    public async Task Starting_after_a_failure_queues_a_new_job_and_resets_progress()
    {
        var (audio, _) = await CreateRecordingAsync();
        var token = await AccessTokenAsync(TestTenants.AlphaContext);
        var first = await StartAsync(audio, token, "none");
        await ClaimAsync(first);
        using (var progress = await InternalAsync(HttpMethod.Post, WorkerRoute("progress"), first, Execution, new { percent = 35 }))
        {
            Assert.Equal(HttpStatusCode.NoContent, progress.StatusCode);
        }
        await FinishAsync(first, succeeded: false, "transcription_decode_failed");

        using (var failed = await SendAsync(HttpMethod.Get, Route(audio), token))
        {
            failed.EnsureSuccessStatusCode();
            using var body = JsonDocument.Parse(await failed.Content.ReadAsStringAsync(Cancellation));
            Assert.Equal("failed", body.RootElement.GetProperty("status").GetString());
            Assert.Equal(35, body.RootElement.GetProperty("progress").GetInt32());
            Assert.Equal("transcription_decode_failed", body.RootElement.GetProperty("errorCode").GetString());
            Assert.NotEqual(JsonValueKind.Null, body.RootElement.GetProperty("completedAt").ValueKind);
            Assert.False(body.RootElement.TryGetProperty("errorDetail", out _));
        }

        var second = await StartAsync(audio, token, "channels");

        Assert.NotEqual(first, second);
        Assert.Equal(2, (await TranscriptionJobsAsync()).Count);
        using var current = await SendAsync(HttpMethod.Get, Route(audio), token);
        current.EnsureSuccessStatusCode();
        using var currentBody = JsonDocument.Parse(await current.Content.ReadAsStringAsync(Cancellation));
        Assert.Equal(second, currentBody.RootElement.GetProperty("operationId").GetGuid());
        Assert.Equal("queued", currentBody.RootElement.GetProperty("status").GetString());
        Assert.Equal(0, currentBody.RootElement.GetProperty("progress").GetInt32());
        Assert.Equal("channels", currentBody.RootElement.GetProperty("speakers").GetString());
        Assert.Equal(JsonValueKind.Null, currentBody.RootElement.GetProperty("errorCode").ValueKind);
    }

    [Fact]
    public async Task A_completed_transcription_reports_a_hundred_percent()
    {
        var (audio, _) = await CreateRecordingAsync();
        var token = await AccessTokenAsync(TestTenants.AlphaContext);
        var job = await StartAsync(audio, token, "none");
        await ClaimAsync(job);
        using (var progress = await InternalAsync(HttpMethod.Post, WorkerRoute("progress"), job, Execution, new { percent = 96 }))
        {
            Assert.Equal(HttpStatusCode.NoContent, progress.StatusCode);
        }
        await FinishAsync(job, succeeded: true, errorCode: null);

        using var status = await SendAsync(HttpMethod.Get, Route(audio), token);

        status.EnsureSuccessStatusCode();
        using var body = JsonDocument.Parse(await status.Content.ReadAsStringAsync(Cancellation));
        Assert.Equal("completed", body.RootElement.GetProperty("status").GetString());
        Assert.Equal(100, body.RootElement.GetProperty("progress").GetInt32());
    }

    [Fact]
    public async Task Starting_is_refused_for_what_is_not_a_recording_in_a_note()
    {
        var token = await AccessTokenAsync(TestTenants.AlphaContext);
        var note = await CreateItemAsync("note", "A note", M0SchemaSeed.Alpha.ItemId);
        var folder = await CreateItemAsync("folder", "A folder", M0SchemaSeed.Alpha.ItemId);

        // Nothing there at all.
        using (var missing = await SendAsync(HttpMethod.Post, Route(Guid.NewGuid()), token, new { speakers = "none" }))
        {
            Assert.Equal(HttpStatusCode.NotFound, missing.StatusCode);
            Assert.Equal("transcriptions.not_found", await ProblemCodeAsync(missing));
        }

        // An item that is not a file.
        using (var notFile = await SendAsync(HttpMethod.Post, Route(note), token, new { speakers = "none" }))
        {
            Assert.Equal(HttpStatusCode.Conflict, notFile.StatusCode);
            Assert.Equal("transcriptions.unsupported", await ProblemCodeAsync(notFile));
        }

        // An audio file whose parent is a folder, and one with no parent.
        var inFolder = await CreateFileAsync("in-folder.mp3", "audio/mpeg", folder);
        using (var wrongParent = await SendAsync(HttpMethod.Post, Route(inFolder), token, new { speakers = "none" }))
        {
            Assert.Equal(HttpStatusCode.Conflict, wrongParent.StatusCode);
            Assert.Equal("transcriptions.unsupported", await ProblemCodeAsync(wrongParent));
        }
        // A parent whose body is not text: there is nowhere in a canvas to append a transcript.
        var canvas = await CreateItemAsync("canvas", "A canvas", M0SchemaSeed.Alpha.ItemId);
        var inCanvas = await CreateFileAsync("in-canvas.mp3", "audio/mpeg", canvas);
        using (var canvasParent = await SendAsync(HttpMethod.Post, Route(inCanvas), token, new { speakers = "none" }))
        {
            Assert.Equal(HttpStatusCode.Conflict, canvasParent.StatusCode);
            Assert.Equal("transcriptions.unsupported", await ProblemCodeAsync(canvasParent));
        }
        var atRoot = await CreateFileAsync("at-root.mp3", "audio/mpeg", parent: null);
        using (var noParent = await SendAsync(HttpMethod.Post, Route(atRoot), token, new { speakers = "none" }))
        {
            Assert.Equal(HttpStatusCode.Conflict, noParent.StatusCode);
            Assert.Equal("transcriptions.unsupported", await ProblemCodeAsync(noParent));
        }

        // A file in a note that is not audio.
        var picture = await CreateFileAsync("whiteboard.png", "image/png", note);
        using (var notAudio = await SendAsync(HttpMethod.Post, Route(picture), token, new { speakers = "none" }))
        {
            Assert.Equal(HttpStatusCode.Conflict, notAudio.StatusCode);
            Assert.Equal("transcriptions.unsupported", await ProblemCodeAsync(notAudio));
        }

        // A recording, asked for with a mode that does not exist, or none.
        var audio = await CreateFileAsync("fine.mp3", "audio/mpeg", note);
        using (var badMode = await SendAsync(HttpMethod.Post, Route(audio), token, new { speakers = "diarize" }))
        {
            Assert.Equal(HttpStatusCode.BadRequest, badMode.StatusCode);
            Assert.Equal("transcriptions.invalid", await ProblemCodeAsync(badMode));
        }
        using (var noMode = await SendAsync(HttpMethod.Post, Route(audio), token, new { }))
        {
            Assert.Equal(HttpStatusCode.BadRequest, noMode.StatusCode);
            Assert.Equal("transcriptions.invalid", await ProblemCodeAsync(noMode));
        }

        Assert.Empty(await TranscriptionJobsAsync());
    }

    [Fact]
    public async Task A_generically_typed_upload_with_an_audio_extension_is_a_recording()
    {
        var note = await CreateItemAsync("note", "Imported call", M0SchemaSeed.Alpha.ItemId);
        var audio = await CreateFileAsync("call.m4a", "application/octet-stream", note);
        var token = await AccessTokenAsync(TestTenants.AlphaContext);

        using var start = await SendAsync(HttpMethod.Post, Route(audio), token, new { speakers = "none" });

        Assert.Equal(HttpStatusCode.Accepted, start.StatusCode);
    }

    [Fact]
    public async Task A_member_who_may_only_read_can_see_the_status_but_cannot_start()
    {
        var (audio, _) = await CreateRecordingAsync();
        await AddColleagueAsync("viewer");
        var viewer = await AccessTokenAsync(ColleagueContext);

        using (var refused = await SendAsync(HttpMethod.Post, Route(audio), viewer, new { speakers = "none" }))
        {
            Assert.Equal(HttpStatusCode.NotFound, refused.StatusCode);
            Assert.Equal("transcriptions.not_found", await ProblemCodeAsync(refused));
        }
        Assert.Empty(await TranscriptionJobsAsync());
        using (var nothingYet = await SendAsync(HttpMethod.Get, Route(audio), viewer))
        {
            Assert.Equal(HttpStatusCode.NotFound, nothingYet.StatusCode);
            Assert.Equal("transcriptions.not_found", await ProblemCodeAsync(nothingYet));
        }

        var owner = await AccessTokenAsync(TestTenants.AlphaContext);
        var job = await StartAsync(audio, owner, "none");
        await ClaimAsync(job);
        using (var progress = await InternalAsync(HttpMethod.Post, WorkerRoute("progress"), job, Execution, new { percent = 12 }))
        {
            Assert.Equal(HttpStatusCode.NoContent, progress.StatusCode);
        }

        // Somebody else's job: invisible as an operation, visible as the recording's status.
        using (var operation = await SendAsync(HttpMethod.Get, $"/api/v1/operations/{job:D}", viewer))
        {
            Assert.Equal(HttpStatusCode.NotFound, operation.StatusCode);
        }
        using var status = await SendAsync(HttpMethod.Get, Route(audio), viewer);
        Assert.Equal(HttpStatusCode.OK, status.StatusCode);
        using var body = JsonDocument.Parse(await status.Content.ReadAsStringAsync(Cancellation));
        Assert.Equal(job, body.RootElement.GetProperty("operationId").GetGuid());
        Assert.Equal("running", body.RootElement.GetProperty("status").GetString());
        Assert.Equal(12, body.RootElement.GetProperty("progress").GetInt32());
    }

    [Fact]
    public async Task A_token_without_the_write_scope_cannot_start()
    {
        var (audio, _) = await CreateRecordingAsync();
        var readOnly = await AccessTokenAsync(TestTenants.AlphaContext, AccessTokenScopes.Read);

        using var refused = await SendAsync(HttpMethod.Post, Route(audio), readOnly, new { speakers = "none" });

        // Refused by the route's scope before the endpoint runs; either way no job exists.
        Assert.Equal(HttpStatusCode.Forbidden, refused.StatusCode);
        Assert.Equal("auth.insufficient_scope", await ProblemCodeAsync(refused));
        Assert.Empty(await TranscriptionJobsAsync());
    }

    [Fact]
    public async Task A_lock_on_the_recording_or_its_note_refuses_the_start_and_hides_the_status()
    {
        var (audio, note) = await CreateRecordingAsync();
        var (otherAudio, _) = await CreateRecordingAsync("Second meeting");
        var token = await AccessTokenAsync(TestTenants.AlphaContext);
        var started = await StartAsync(otherAudio, token, "none");
        Assert.NotEqual(Guid.Empty, started);

        // A lock on the note covers the recording under it.
        await LockAsync(note);
        using (var noteLocked = await SendAsync(HttpMethod.Post, Route(audio), token, new { speakers = "none" }))
        {
            Assert.Equal(HttpStatusCode.Conflict, noteLocked.StatusCode);
            Assert.Equal("transcriptions.locked", await ProblemCodeAsync(noteLocked));
        }

        // A lock on the recording alone.
        await LockAsync(otherAudio);
        using (var audioLocked = await SendAsync(HttpMethod.Post, Route(otherAudio), token, new { speakers = "none" }))
        {
            Assert.Equal(HttpStatusCode.Conflict, audioLocked.StatusCode);
            Assert.Equal("transcriptions.locked", await ProblemCodeAsync(audioLocked));
        }
        using (var hidden = await SendAsync(HttpMethod.Get, Route(otherAudio), token))
        {
            Assert.Equal(HttpStatusCode.NotFound, hidden.StatusCode);
            Assert.Equal("transcriptions.not_found", await ProblemCodeAsync(hidden));
        }

        Assert.Single(await TranscriptionJobsAsync());
    }

    [Fact]
    public async Task Another_tenant_can_neither_start_nor_see_a_transcription()
    {
        var (audio, _) = await CreateRecordingAsync();
        var alpha = await AccessTokenAsync(TestTenants.AlphaContext);
        var job = await StartAsync(audio, alpha, "none");
        var beta = await AccessTokenAsync(TestTenants.BetaContext);

        using (var start = await SendAsync(HttpMethod.Post, Route(audio), beta, new { speakers = "none" }))
        {
            Assert.Equal(HttpStatusCode.NotFound, start.StatusCode);
            Assert.Equal("transcriptions.not_found", await ProblemCodeAsync(start));
        }
        using (var status = await SendAsync(HttpMethod.Get, Route(audio), beta))
        {
            Assert.Equal(HttpStatusCode.NotFound, status.StatusCode);
        }

        // And the other way: Beta's seeded transcription row is not Alpha's to read.
        using (var foreign = await SendAsync(HttpMethod.Get, Route(M0SchemaSeed.Beta.ItemId), alpha))
        {
            Assert.Equal(HttpStatusCode.NotFound, foreign.StatusCode);
        }

        // The store itself, under Beta's session, finds nothing for Alpha's recording and cannot
        // move its progress even naming the right job.
        await using (var work = await _fixture.Application.BeginUnitOfWorkAsync(TestTenants.BetaContext, Cancellation))
        {
            var store = work.Resolve<IItemTranscriptionStore>();
            Assert.Null(await store.FindAsync(ItemId.From(audio), Cancellation));
            await store.ReportProgressAsync(ItemId.From(audio), WorkerJobId.From(job), 80, Cancellation);
            await work.CommitAsync(Cancellation);
        }
        using var unchanged = await SendAsync(HttpMethod.Get, Route(audio), alpha);
        unchanged.EnsureSuccessStatusCode();
        using var body = JsonDocument.Parse(await unchanged.Content.ReadAsStringAsync(Cancellation));
        Assert.Equal(0, body.RootElement.GetProperty("progress").GetInt32());
        Assert.Single(await TranscriptionJobsAsync());
    }

    [Fact]
    public async Task The_worker_is_given_the_audio_only_under_the_live_execution_of_a_transcription()
    {
        var (audio, note) = await CreateRecordingAsync();
        var token = await AccessTokenAsync(TestTenants.AlphaContext);
        var job = await StartAsync(audio, token, "channels");

        // Queued, not yet claimed: no execution owns it.
        using (var unclaimed = await InternalAsync(HttpMethod.Get, WorkerRoute("source"), job, Execution))
        {
            Assert.Equal(HttpStatusCode.Conflict, unclaimed.StatusCode);
        }

        await ClaimAsync(job);
        using (var source = await InternalAsync(HttpMethod.Get, WorkerRoute("source"), job, Execution))
        {
            Assert.Equal(HttpStatusCode.OK, source.StatusCode);
            using var body = JsonDocument.Parse(await source.Content.ReadAsStringAsync(Cancellation));
            var root = body.RootElement;
            Assert.Equal(6, root.EnumerateObject().Count());
            var url = root.GetProperty("sourceUrl").GetString();
            Assert.Contains("X-Amz-Signature", url, StringComparison.Ordinal);
            Assert.Contains("/nix-objects/", url, StringComparison.Ordinal);
            Assert.Equal(4096, root.GetProperty("byteLength").GetInt64());
            Assert.Equal(audio, root.GetProperty("audioItemId").GetGuid());
            Assert.Equal(note, root.GetProperty("noteItemId").GetGuid());
            Assert.Equal(TestTenants.AlphaWorkspace, root.GetProperty("workspaceId").GetGuid());
            Assert.Equal("channels", root.GetProperty("speakers").GetString());
        }

        using (var stale = await InternalAsync(HttpMethod.Get, WorkerRoute("source"), job, "stale-execution"))
        {
            Assert.Equal(HttpStatusCode.Conflict, stale.StatusCode);
            Assert.Equal("worker.execution_refused", await ProblemCodeAsync(stale));
        }
        using (var noSecret = await InternalAsync(HttpMethod.Get, WorkerRoute("source"), job, Execution, secret: "wrong"))
        {
            Assert.Equal(HttpStatusCode.NotFound, noSecret.StatusCode);
        }

        // A live lease on some other kind of job is not a lease on a recording.
        var otherKind = await CreateJobAsync("import.commit", """{"audioItemId":"00000000-0000-0000-0000-000000000000"}""");
        await ClaimAsync(otherKind);
        foreach (var route in new[] { "source", "authorization" })
        {
            using var wrongKind = await InternalAsync(HttpMethod.Get, WorkerRoute(route), otherKind, Execution);
            Assert.Equal(HttpStatusCode.NotFound, wrongKind.StatusCode);
        }
        using (var wrongKindProgress = await InternalAsync(HttpMethod.Post, WorkerRoute("progress"), otherKind, Execution, new { percent = 50 }))
        {
            Assert.Equal(HttpStatusCode.NotFound, wrongKindProgress.StatusCode);
        }

        // A recording locked after the start: the worker session holds no unlock.
        await LockAsync(audio);
        using (var locked = await InternalAsync(HttpMethod.Get, WorkerRoute("source"), job, Execution))
        {
            Assert.Equal(HttpStatusCode.NotFound, locked.StatusCode);
            Assert.Equal("transcriptions.not_found", await ProblemCodeAsync(locked));
        }
    }

    [Fact]
    public async Task Progress_only_rises_and_a_superseded_job_cannot_move_it()
    {
        var (audio, note) = await CreateRecordingAsync();
        var token = await AccessTokenAsync(TestTenants.AlphaContext);
        var job = await StartAsync(audio, token, "none");
        await ClaimAsync(job);

        Assert.Equal(HttpStatusCode.NoContent, await ReportAsync(job, 40));
        Assert.Equal(40, await ProgressAsync(audio, token));
        Assert.Equal(HttpStatusCode.NoContent, await ReportAsync(job, 25));
        Assert.Equal(40, await ProgressAsync(audio, token));
        Assert.Equal(HttpStatusCode.NoContent, await ReportAsync(job, 40));
        Assert.Equal(40, await ProgressAsync(audio, token));
        Assert.Equal(HttpStatusCode.NoContent, await ReportAsync(job, 70));
        Assert.Equal(70, await ProgressAsync(audio, token));

        Assert.Equal(HttpStatusCode.BadRequest, await ReportAsync(job, 101));
        Assert.Equal(HttpStatusCode.BadRequest, await ReportAsync(job, -1));
        Assert.Equal(HttpStatusCode.Conflict, await ReportAsync(job, 90, "stale-execution"));
        Assert.Equal(70, await ProgressAsync(audio, token));

        // The row is repointed at a newer job while the first still holds a live lease - what a
        // restart racing a slow worker looks like. The old job's reports are accepted and dropped.
        var successor = await CreateJobAsync(
            "transcribe.audio",
            JsonSerializer.Serialize(new { audioItemId = audio, noteItemId = note, speakers = "none" }));
        await using (var work = await _fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation))
        {
            Assert.True(await work.Resolve<IItemTranscriptionStore>().PointAtJobAsync(
                new StartedItemTranscription(
                    ItemId.From(audio),
                    WorkspaceId.From(TestTenants.AlphaWorkspace),
                    ItemId.From(note),
                    WorkerJobId.From(successor),
                    "none",
                    PrincipalId.From(TestTenants.AlphaPrincipal)),
                Cancellation));
            await work.CommitAsync(Cancellation);
        }

        Assert.Equal(HttpStatusCode.NoContent, await ReportAsync(job, 95));

        using var status = await SendAsync(HttpMethod.Get, Route(audio), token);
        status.EnsureSuccessStatusCode();
        using var body = JsonDocument.Parse(await status.Content.ReadAsStringAsync(Cancellation));
        Assert.Equal(successor, body.RootElement.GetProperty("operationId").GetGuid());
        Assert.Equal(0, body.RootElement.GetProperty("progress").GetInt32());
    }

    [Fact]
    public async Task The_append_authorization_names_the_actor_the_note_and_the_recording_title()
    {
        var note = await CreateItemAsync("note", "Planning", M0SchemaSeed.Alpha.ItemId);
        var audio = await CreateFileAsync("Planning call.mp3", "audio/mpeg", note);
        var token = await AccessTokenAsync(TestTenants.AlphaContext);
        // Written directly: the bound under test is this endpoint's own, whatever a rename allows.
        var connection = await _fixture.OpenMigratorConnectionAsync();
        await using (connection.ConfigureAwait(false))
        {
            await RawSql.ExecuteAsync(
                connection,
                transaction: null,
                $"UPDATE item SET properties = jsonb_build_object('title', repeat('t', 620)) WHERE id = '{audio:D}'::uuid");
        }
        var job = await StartAsync(audio, token, "none");
        await ClaimAsync(job);

        using var authorization = await InternalAsync(HttpMethod.Get, WorkerRoute("authorization"), job, Execution);

        Assert.Equal(HttpStatusCode.OK, authorization.StatusCode);
        using var body = JsonDocument.Parse(await authorization.Content.ReadAsStringAsync(Cancellation));
        var root = body.RootElement;
        Assert.Equal(7, root.EnumerateObject().Count());
        Assert.Equal(TestTenants.Alpha, root.GetProperty("tenantId").GetGuid());
        Assert.Equal(TestTenants.AlphaPrincipal, root.GetProperty("principalId").GetGuid());
        Assert.Equal(TestTenants.AlphaWorkspace, root.GetProperty("workspaceId").GetGuid());
        Assert.Equal(note, root.GetProperty("noteItemId").GetGuid());
        Assert.Equal(audio, root.GetProperty("audioItemId").GetGuid());
        Assert.True(root.GetProperty("canWrite").GetBoolean());
        var title = root.GetProperty("audioTitle").GetString();
        Assert.NotNull(title);
        Assert.Equal(500, title.Length);
        Assert.StartsWith("ttt", title, StringComparison.Ordinal);

        // Ordinary hyphenated UUID strings, which is what the collaboration service parses.
        foreach (var id in new[] { "tenantId", "principalId", "workspaceId", "noteItemId", "audioItemId" })
        {
            Assert.Matches("^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", root.GetProperty(id).GetString());
        }

        using var stale = await InternalAsync(HttpMethod.Get, WorkerRoute("authorization"), job, "stale-execution");
        Assert.Equal(HttpStatusCode.Conflict, stale.StatusCode);
    }

    [Fact]
    public async Task An_untitled_recording_is_labelled_by_its_file_name()
    {
        var note = await CreateItemAsync("note", "Planning", M0SchemaSeed.Alpha.ItemId);
        var audio = await CreateFileAsync("untitled-call.mp3", "audio/mpeg", note);
        var token = await AccessTokenAsync(TestTenants.AlphaContext);
        var job = await StartAsync(audio, token, "none");
        await ClaimAsync(job);
        var connection = await _fixture.OpenMigratorConnectionAsync();
        await using (connection.ConfigureAwait(false))
        {
            await RawSql.ExecuteAsync(
                connection,
                transaction: null,
                $"UPDATE item SET properties = NULL WHERE id = '{audio:D}'::uuid");
        }

        using var authorization = await InternalAsync(HttpMethod.Get, WorkerRoute("authorization"), job, Execution);

        Assert.Equal(HttpStatusCode.OK, authorization.StatusCode);
        using var body = JsonDocument.Parse(await authorization.Content.ReadAsStringAsync(Cancellation));
        Assert.Equal("untitled-call.mp3", body.RootElement.GetProperty("audioTitle").GetString());
    }

    [Fact]
    public async Task The_append_authorization_is_withdrawn_when_the_note_is_deleted()
    {
        var (audio, note) = await CreateRecordingAsync();
        var token = await AccessTokenAsync(TestTenants.AlphaContext);
        var job = await StartAsync(audio, token, "none");
        await ClaimAsync(job);
        using (var before = await InternalAsync(HttpMethod.Get, WorkerRoute("authorization"), job, Execution))
        {
            Assert.Equal(HttpStatusCode.OK, before.StatusCode);
        }

        using (var delete = await SendAsync(HttpMethod.Delete, $"/api/v1/items/{note:D}", token))
        {
            delete.EnsureSuccessStatusCode();
        }

        using var authorization = await InternalAsync(HttpMethod.Get, WorkerRoute("authorization"), job, Execution);
        Assert.Equal(HttpStatusCode.NotFound, authorization.StatusCode);
        Assert.Equal("transcriptions.not_found", await ProblemCodeAsync(authorization));
        using var source = await InternalAsync(HttpMethod.Get, WorkerRoute("source"), job, Execution);
        Assert.Equal(HttpStatusCode.NotFound, source.StatusCode);
    }

    [Fact]
    public async Task The_append_authorization_is_withdrawn_when_the_actor_loses_write_access()
    {
        var (audio, _) = await CreateRecordingAsync();
        await AddColleagueAsync("editor");
        var colleague = await AccessTokenAsync(ColleagueContext);
        var job = await StartAsync(audio, colleague, "none");
        await ClaimAsync(job);
        using (var before = await InternalAsync(HttpMethod.Get, WorkerRoute("authorization"), job, Execution))
        {
            Assert.Equal(HttpStatusCode.OK, before.StatusCode);
            using var body = JsonDocument.Parse(await before.Content.ReadAsStringAsync(Cancellation));
            Assert.Equal(Colleague, body.RootElement.GetProperty("principalId").GetGuid());
        }

        // Demoted to a reader: the recording is still theirs to hear, the note no longer theirs
        // to write.
        await SetColleagueRoleAsync("viewer");

        using (var authorization = await InternalAsync(HttpMethod.Get, WorkerRoute("authorization"), job, Execution))
        {
            Assert.Equal(HttpStatusCode.NotFound, authorization.StatusCode);
        }
        using (var source = await InternalAsync(HttpMethod.Get, WorkerRoute("source"), job, Execution))
        {
            Assert.Equal(HttpStatusCode.NotFound, source.StatusCode);
        }

        // Removed altogether: nothing is readable either.
        await RemoveColleagueAsync();
        using var removed = await InternalAsync(HttpMethod.Get, WorkerRoute("authorization"), job, Execution);
        Assert.Equal(HttpStatusCode.NotFound, removed.StatusCode);
    }

    [Fact]
    public async Task Purging_the_recording_takes_its_transcription_row_with_it()
    {
        var (audio, note) = await CreateRecordingAsync();
        var token = await AccessTokenAsync(TestTenants.AlphaContext);
        await StartAsync(audio, token, "none");

        var connection = await _fixture.OpenMigratorConnectionAsync();
        await using (connection.ConfigureAwait(false))
        {
            Assert.Equal(1L, await RawSql.CountAsync(
                connection,
                transaction: null,
                $"SELECT count(*) FROM item_transcription WHERE audio_item_id = '{audio:D}'::uuid"));

            // The note is named by the row but owns nothing in it: removing the note's row alone
            // would be refused by the item tree, so the recording goes first, as a purge does.
            await RawSql.ExecuteAsync(
                connection,
                transaction: null,
                $"""
                DELETE FROM file_body WHERE item_id = '{audio:D}'::uuid;
                DELETE FROM file_version WHERE item_id = '{audio:D}'::uuid;
                DELETE FROM file_upload WHERE published_item_id = '{audio:D}'::uuid;
                DELETE FROM item_closure WHERE descendant_id = '{audio:D}'::uuid;
                DELETE FROM item WHERE id = '{audio:D}'::uuid;
                """);

            Assert.Equal(0L, await RawSql.CountAsync(
                connection,
                transaction: null,
                $"SELECT count(*) FROM item_transcription WHERE audio_item_id = '{audio:D}'::uuid"));
            Assert.Equal(1L, await RawSql.CountAsync(
                connection,
                transaction: null,
                $"SELECT count(*) FROM item WHERE id = '{note:D}'::uuid"));
        }
    }

    [Fact]
    public async Task The_worker_routes_have_exactly_the_shape_of_the_shared_worker_fixtures()
    {
        var note = await CreateItemAsync("note", "Weekly sync", M0SchemaSeed.Alpha.ItemId);
        var audio = await CreateFileAsync("Meeting 2026-10-05 14.30.weba", "audio/webm", note);
        var token = await AccessTokenAsync(TestTenants.AlphaContext);
        var job = await StartAsync(audio, token, "channels");
        await ClaimAsync(job);

        using (var source = await InternalAsync(HttpMethod.Get, WorkerRoute("source"), job, Execution))
        {
            Assert.Equal(HttpStatusCode.OK, source.StatusCode);
            using var body = JsonDocument.Parse(await source.Content.ReadAsStringAsync(Cancellation));
            var expected = Fixture("t1_source_response.json");
            AssertSameShape(expected, body.RootElement);
            Assert.Equal(expected.GetProperty("speakers").GetString(), body.RootElement.GetProperty("speakers").GetString());
            Assert.True(Uri.TryCreate(body.RootElement.GetProperty("sourceUrl").GetString(), UriKind.Absolute, out _));
            Assert.True(body.RootElement.GetProperty("byteLength").TryGetInt64(out _));
        }

        // The fixture body exactly as the Go worker serializes it.
        using (var request = new HttpRequestMessage(HttpMethod.Post, WorkerRoute("progress")))
        {
            request.Headers.TryAddWithoutValidation(InternalBoundaryMiddleware.SecretHeaderName, InternalSecret);
            request.Headers.TryAddWithoutValidation(WorkerExecutionMiddleware.JobHeaderName, job.ToString("D"));
            request.Headers.TryAddWithoutValidation(WorkerExecutionMiddleware.ExecutionHeaderName, Execution);
            request.Content = new StringContent(FixtureText("t2_progress_request.json"), System.Text.Encoding.UTF8, "application/json");
            using var progress = await _client.SendAsync(request, Cancellation);
            Assert.Equal(HttpStatusCode.NoContent, progress.StatusCode);
        }
        Assert.Equal(Fixture("t2_progress_request.json").GetProperty("percent").GetInt32(), await ProgressAsync(audio, token));

        using var authorization = await InternalAsync(HttpMethod.Get, WorkerRoute("authorization"), job, Execution);
        Assert.Equal(HttpStatusCode.OK, authorization.StatusCode);
        using var answer = JsonDocument.Parse(await authorization.Content.ReadAsStringAsync(Cancellation));
        var authorized = Fixture("t3_authorization_response.json");
        AssertSameShape(authorized, answer.RootElement);
        Assert.Equal(authorized.GetProperty("canWrite").GetBoolean(), answer.RootElement.GetProperty("canWrite").GetBoolean());
        Assert.Equal(authorized.GetProperty("audioTitle").GetString(), answer.RootElement.GetProperty("audioTitle").GetString());
    }

    [Fact]
    public async Task A_lock_refuses_the_start_even_for_a_caller_who_holds_it_open()
    {
        var (audio, note) = await CreateRecordingAsync();
        var token = await AccessTokenAsync(TestTenants.AlphaContext);

        // Setting the lock leaves this credential holding an unlock grant: it can read the note
        // and the recording. The worker and the collaboration service could not.
        using (var locked = await SendAsync(HttpMethod.Put, $"/api/v1/items/{note:D}/lock", token, new { password = "hunter22" }))
        {
            Assert.Equal(HttpStatusCode.NoContent, locked.StatusCode);
        }
        using (var state = await SendAsync(HttpMethod.Get, $"/api/v1/items/{note:D}/lock", token))
        {
            state.EnsureSuccessStatusCode();
            using var body = JsonDocument.Parse(await state.Content.ReadAsStringAsync(Cancellation));
            Assert.True(body.RootElement.GetProperty("locked").GetBoolean());
            Assert.NotEqual(JsonValueKind.Null, body.RootElement.GetProperty("unlockedUntil").ValueKind);
        }

        using (var refused = await SendAsync(HttpMethod.Post, Route(audio), token, new { speakers = "none" }))
        {
            Assert.Equal(HttpStatusCode.Conflict, refused.StatusCode);
            Assert.Equal("transcriptions.locked", await ProblemCodeAsync(refused));
        }

        // The same for a lock on the recording itself, opened by this caller.
        var (otherAudio, _) = await CreateRecordingAsync("Second meeting");
        using (var locked = await SendAsync(HttpMethod.Put, $"/api/v1/items/{otherAudio:D}/lock", token, new { password = "hunter22" }))
        {
            Assert.Equal(HttpStatusCode.NoContent, locked.StatusCode);
        }
        using (var refused = await SendAsync(HttpMethod.Post, Route(otherAudio), token, new { speakers = "none" }))
        {
            Assert.Equal(HttpStatusCode.Conflict, refused.StatusCode);
            Assert.Equal("transcriptions.locked", await ProblemCodeAsync(refused));
        }

        Assert.Empty(await TranscriptionJobsAsync());
    }

    [Fact]
    public async Task A_lock_on_an_ancestor_refuses_the_start_whether_or_not_the_caller_holds_it_open()
    {
        var folder = await CreateItemAsync("folder", "Meetings", M0SchemaSeed.Alpha.ItemId);
        var note = await CreateItemAsync("note", "Weekly sync", folder);
        var audio = await CreateFileAsync("weekly-sync.weba", "audio/webm", note);
        var token = await AccessTokenAsync(TestTenants.AlphaContext);

        // Locked by somebody else: no grant for this credential.
        await LockAsync(folder);
        using (var closed = await SendAsync(HttpMethod.Post, Route(audio), token, new { speakers = "none" }))
        {
            Assert.Equal(HttpStatusCode.Conflict, closed.StatusCode);
            Assert.Equal("transcriptions.locked", await ProblemCodeAsync(closed));
        }

        // And a different folder this credential locked itself, and so holds open.
        var ownFolder = await CreateItemAsync("folder", "My meetings", M0SchemaSeed.Alpha.ItemId);
        var ownNote = await CreateItemAsync("note", "One to one", ownFolder);
        var ownAudio = await CreateFileAsync("one-to-one.weba", "audio/webm", ownNote);
        using (var locked = await SendAsync(HttpMethod.Put, $"/api/v1/items/{ownFolder:D}/lock", token, new { password = "hunter22" }))
        {
            Assert.Equal(HttpStatusCode.NoContent, locked.StatusCode);
        }
        using (var open = await SendAsync(HttpMethod.Post, Route(ownAudio), token, new { speakers = "none" }))
        {
            Assert.Equal(HttpStatusCode.Conflict, open.StatusCode);
            Assert.Equal("transcriptions.locked", await ProblemCodeAsync(open));
        }

        Assert.Empty(await TranscriptionJobsAsync());
    }

    [Fact]
    public async Task Two_starts_arriving_together_queue_one_job_and_both_are_told_about_it()
    {
        var token = await AccessTokenAsync(TestTenants.AlphaContext);

        // Several recordings, so one lucky interleaving cannot pass for the lock working.
        for (var round = 0; round < 5; round++)
        {
            var (audio, _) = await CreateRecordingAsync($"Meeting {round}");

            var operations = await Task.WhenAll(Enumerable.Range(0, 4).Select(_ => StartAsync(audio, token, "none")));

            Assert.Single(operations.Distinct());
            Assert.Equal(round + 1, (await TranscriptionJobsAsync()).Count);
        }
    }

    [Fact]
    public async Task Starting_says_so_when_the_deployment_has_no_object_storage()
    {
        var (audio, _) = await CreateRecordingAsync();
        await using var factory = CreateFactory(withObjectStorage: false);
        using var client = factory.CreateClient();
        var token = await AccessTokenAsync(client, TestTenants.AlphaContext);

        using var request = new HttpRequestMessage(HttpMethod.Post, Route(audio));
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
        request.Content = JsonContent.Create(new { speakers = "none" });
        using var refused = await client.SendAsync(request, Cancellation);

        Assert.Equal(HttpStatusCode.ServiceUnavailable, refused.StatusCode);
        Assert.Equal("transcriptions.storage_not_configured", await ProblemCodeAsync(refused));
        Assert.Empty(await TranscriptionJobsAsync());
    }

    [Fact]
    public async Task A_recording_locked_after_the_start_withdraws_the_append_authorization()
    {
        var (audio, _) = await CreateRecordingAsync();
        var token = await AccessTokenAsync(TestTenants.AlphaContext);
        var job = await StartAsync(audio, token, "none");
        await ClaimAsync(job);
        using (var before = await InternalAsync(HttpMethod.Get, WorkerRoute("authorization"), job, Execution))
        {
            Assert.Equal(HttpStatusCode.OK, before.StatusCode);
        }

        // Only the recording: the note it would be written into stays unlocked.
        await LockAsync(audio);

        using var authorization = await InternalAsync(HttpMethod.Get, WorkerRoute("authorization"), job, Execution);
        Assert.Equal(HttpStatusCode.NotFound, authorization.StatusCode);
        Assert.Equal("transcriptions.not_found", await ProblemCodeAsync(authorization));
    }

    [Fact]
    public async Task A_status_row_recorded_for_another_workspace_is_not_reported()
    {
        var (audio, _) = await CreateRecordingAsync();
        var token = await AccessTokenAsync(TestTenants.AlphaContext);
        await StartAsync(audio, token, "none");

        // Items cannot be moved between workspaces through the API, so the mismatch is written
        // directly: the row now claims the transcript went to a workspace the item is not in.
        var connection = await _fixture.OpenMigratorConnectionAsync();
        await using (connection.ConfigureAwait(false))
        {
            await RawSql.ExecuteAsync(
                connection,
                transaction: null,
                $"UPDATE item_transcription SET workspace_id = '{Guid.NewGuid():D}'::uuid WHERE audio_item_id = '{audio:D}'::uuid");
        }

        using var status = await SendAsync(HttpMethod.Get, Route(audio), token);
        Assert.Equal(HttpStatusCode.NotFound, status.StatusCode);
        Assert.Equal("transcriptions.not_found", await ProblemCodeAsync(status));
    }

    [Fact]
    public async Task Pointing_at_a_job_for_a_recording_that_no_longer_exists_reports_it_instead_of_throwing()
    {
        var note = await CreateItemAsync("note", "Weekly sync", M0SchemaSeed.Alpha.ItemId);
        var job = await CreateJobAsync("transcribe.audio", """{"speakers":"none"}""");

        await using var work = await _fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        var written = await work.Resolve<IItemTranscriptionStore>().PointAtJobAsync(
            new StartedItemTranscription(
                ItemId.From(Guid.NewGuid()),
                WorkspaceId.From(TestTenants.AlphaWorkspace),
                ItemId.From(note),
                WorkerJobId.From(job),
                "none",
                PrincipalId.From(TestTenants.AlphaPrincipal)),
            Cancellation);

        // The foreign key to the audio item refused the row; the endpoint turns this into 404.
        Assert.False(written);
    }

    private ConfiguredApplicationFactory CreateFactory(bool withObjectStorage)
    {
        string signingKey;
        using (var key = ECDsa.Create(ECCurve.NamedCurves.nistP256))
        {
            signingKey = key.ExportECPrivateKeyPem();
        }
        var settings = new Dictionary<string, string?>
        {
            ["ConnectionStrings:Nix"] = _fixture.ApplicationConnectionString,
            [InternalBoundaryMiddleware.SecretConfigurationKey] = InternalSecret,
            [SelfIssuedTokenService.IssuerConfigurationKey] = "https://core.transcription-http.test",
            [SelfIssuedTokenService.AudienceConfigurationKey] = "nix",
            [SelfIssuedTokenService.KeyIdConfigurationKey] = "transcription-http-key",
            [SelfIssuedTokenService.SigningKeyConfigurationKey] = signingKey,
        };
        if (withObjectStorage)
        {
            settings["Nix:ObjectStorage:Endpoint"] = "http://127.0.0.1:7070";
            settings["Nix:ObjectStorage:Region"] = "us-east-1";
            settings["Nix:ObjectStorage:Bucket"] = "nix-objects";
            settings["Nix:ObjectStorage:AccessKey"] = "transcription-access";
            settings["Nix:ObjectStorage:SecretKey"] = "transcription-secret";
        }
        return new ConfiguredApplicationFactory(settings);
    }

    private static NixSessionContext ColleagueContext =>
        TestTenants.ContextFor(TestTenants.Alpha, TestTenants.AlphaWorkspace, Colleague);

    private static string Route(Guid audio) => $"/api/v1/items/{audio:D}/transcription";

    private static string WorkerRoute(string leaf) => $"/internal/worker-executions/transcriptions/{leaf}";

    private async Task<(Guid Audio, Guid Note)> CreateRecordingAsync(string title = "Meeting")
    {
        var note = await CreateItemAsync("note", title, M0SchemaSeed.Alpha.ItemId);
        var audio = await CreateFileAsync($"{title}.weba", "audio/webm", note);
        return (audio, note);
    }

    private async Task<Guid> StartAsync(Guid audio, string token, string speakers)
    {
        using var start = await SendAsync(HttpMethod.Post, Route(audio), token, new { speakers });
        Assert.Equal(HttpStatusCode.Accepted, start.StatusCode);
        using var body = JsonDocument.Parse(await start.Content.ReadAsStringAsync(Cancellation));
        return body.RootElement.GetProperty("operationId").GetGuid();
    }

    private async Task<HttpStatusCode> ReportAsync(Guid job, int percent, string execution = Execution)
    {
        using var response = await InternalAsync(HttpMethod.Post, WorkerRoute("progress"), job, execution, new { percent });
        return response.StatusCode;
    }

    private async Task<int> ProgressAsync(Guid audio, string token)
    {
        using var status = await SendAsync(HttpMethod.Get, Route(audio), token);
        status.EnsureSuccessStatusCode();
        using var body = JsonDocument.Parse(await status.Content.ReadAsStringAsync(Cancellation));
        return body.RootElement.GetProperty("progress").GetInt32();
    }

    private async Task ClaimAsync(Guid job)
    {
        await using var scope = _fixture.Application.CreateUnscopedScope();
        var dispatch = scope.ServiceProvider.GetRequiredService<WorkerDispatchStore>();
        Assert.NotNull(await dispatch.ClaimJobAsync(job, Execution, 60, Cancellation));
    }

    private async Task FinishAsync(Guid job, bool succeeded, string? errorCode)
    {
        await using var scope = _fixture.Application.CreateUnscopedScope();
        var dispatch = scope.ServiceProvider.GetRequiredService<WorkerDispatchStore>();
        Assert.True(await dispatch.FinishJobAsync(
            job,
            Execution,
            succeeded,
            retryable: false,
            succeeded ? """{"segments":3}""" : null,
            errorCode,
            succeeded ? null : "A detail that must never reach the public status.",
            Cancellation));
    }

    private async Task<Guid> CreateJobAsync(string kind, string payload)
    {
        await using var work = await _fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        var job = await work.Resolve<IWorkerJobStore>().CreateAsync(
            TenantId.From(TestTenants.Alpha),
            PrincipalId.From(TestTenants.AlphaPrincipal),
            WorkspaceId.From(TestTenants.AlphaWorkspace),
            kind,
            $"transcription-http:{Guid.NewGuid():N}",
            payload,
            Cancellation);
        await work.CommitAsync(Cancellation);
        return job.Id;
    }

    private async Task<IReadOnlyList<(Guid Id, string Kind, Guid WorkspaceId, Guid ActorId, string Payload)>> TranscriptionJobsAsync()
    {
        var connection = await _fixture.OpenMigratorConnectionAsync();
        await using (connection.ConfigureAwait(false))
        {
            var jobs = new List<(Guid, string, Guid, Guid, string)>();
            var command = connection.CreateCommand();
            await using (command.ConfigureAwait(false))
            {
                command.CommandText = """
                    SELECT job_id, kind, workspace_id, actor_id, payload::text
                    FROM worker_job
                    WHERE tenant_id = @tenant AND kind = 'transcribe.audio'
                    ORDER BY created_at
                    """;
                command.Parameters.AddWithValue("tenant", TestTenants.Alpha);
                var reader = await command.ExecuteReaderAsync(Cancellation);
                await using (reader.ConfigureAwait(false))
                {
                    while (await reader.ReadAsync(Cancellation))
                    {
                        jobs.Add((reader.GetGuid(0), reader.GetString(1), reader.GetGuid(2), reader.GetGuid(3), reader.GetString(4)));
                    }
                }
            }
            return jobs;
        }
    }

    private async Task LockAsync(Guid item)
    {
        var connection = await _fixture.OpenMigratorConnectionAsync();
        await using (connection.ConfigureAwait(false))
        {
            await RawSql.ExecuteAsync(
                connection,
                transaction: null,
                $"""
                INSERT INTO item_lock (item_id, tenant_id, password_hash, locked_by, locked_at)
                VALUES ('{item:D}'::uuid, '{TestTenants.Alpha:D}'::uuid,
                        'pbkdf2-sha256$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
                        '{TestTenants.AlphaPrincipal:D}'::uuid, now());
                """);
        }
    }

    private async Task AddColleagueAsync(string role)
    {
        var connection = await _fixture.OpenMigratorConnectionAsync();
        await using (connection.ConfigureAwait(false))
        {
            await RawSql.ExecuteAsync(
                connection,
                transaction: null,
                $"""
                INSERT INTO principal
                    (principal_id, tenant_id, external_issuer, external_subject, kind, display_name,
                     email, email_normalized, email_verified, status, deprovisioned_at)
                VALUES ('{Colleague:D}'::uuid, '{TestTenants.Alpha:D}'::uuid, 'https://issuer.alpha.test',
                        'alpha-colleague', 'user', 'alpha colleague', 'colleague@example.test',
                        'colleague@example.test', true, 'active', NULL);

                INSERT INTO workspace_member
                    (workspace_id, subject_type, subject_id, tenant_id, role, granted_by, granted_at)
                VALUES ('{TestTenants.AlphaWorkspace:D}'::uuid, 'principal', '{Colleague:D}'::uuid,
                        '{TestTenants.Alpha:D}'::uuid, '{role}', '{TestTenants.AlphaPrincipal:D}'::uuid, now());
                """);
        }
    }

    private async Task SetColleagueRoleAsync(string role)
    {
        var connection = await _fixture.OpenMigratorConnectionAsync();
        await using (connection.ConfigureAwait(false))
        {
            await RawSql.ExecuteAsync(
                connection,
                transaction: null,
                $"""
                UPDATE workspace_member SET role = '{role}'
                WHERE tenant_id = '{TestTenants.Alpha:D}'::uuid
                  AND workspace_id = '{TestTenants.AlphaWorkspace:D}'::uuid
                  AND subject_id = '{Colleague:D}'::uuid;
                """);
        }
    }

    private async Task RemoveColleagueAsync()
    {
        var connection = await _fixture.OpenMigratorConnectionAsync();
        await using (connection.ConfigureAwait(false))
        {
            await RawSql.ExecuteAsync(
                connection,
                transaction: null,
                $"""
                DELETE FROM workspace_member
                WHERE tenant_id = '{TestTenants.Alpha:D}'::uuid
                  AND workspace_id = '{TestTenants.AlphaWorkspace:D}'::uuid
                  AND subject_id = '{Colleague:D}'::uuid;
                """);
        }
    }

    private async Task<Guid> CreateFileAsync(string fileName, string mediaType, Guid? parent)
    {
        await using var work = await _fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        var files = work.Resolve<IFileStore>();
        var upload = Assert.IsType<FileUploadRecord>(await files.BeginAsync(
            new BeginFileUpload(
                WorkspaceId.From(TestTenants.AlphaWorkspace),
                parent is { } parentId ? ItemId.From(parentId) : null,
                null,
                fileName,
                mediaType,
                4096,
                $"transcription-http:{Guid.NewGuid():N}"),
            Cancellation));
        Assert.NotNull(await files.QueueInspectionAsync(FileUploadId.From(upload.Id), Cancellation));
        var file = Assert.IsType<FileRecord>(await files.CompleteAsync(
            new CompleteFileUpload(
                FileUploadId.From(upload.Id),
                mediaType,
                4096,
                new string('c', 64),
                Previewable: false,
                PixelWidth: null,
                PixelHeight: null),
            Cancellation));
        await work.CommitAsync(Cancellation);
        return file.ItemId;
    }

    private async Task<Guid> CreateItemAsync(string type, string title, Guid parentId)
    {
        await using var work = await _fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        var result = await work.Resolve<NixDispatcher>().SendAsync<CreateItem, Item>(
            new CreateItem(
                WorkspaceId.From(TestTenants.AlphaWorkspace),
                type,
                title,
                ItemId.From(parentId),
                Properties: null),
            Cancellation);
        Assert.True(result.IsSuccess, result.IsFailure ? result.Error.Message : string.Empty);
        await work.CommitAsync(Cancellation);
        return result.Value.Id.Value;
    }

    private Task<string> AccessTokenAsync(NixSessionContext principal, params string[] scopes) =>
        AccessTokenAsync(_client, principal, scopes);

    /// <summary>Exchanged at <paramref name="client"/>'s host, whose signing key is the one that must verify it.</summary>
    private async Task<string> AccessTokenAsync(HttpClient client, NixSessionContext principal, params string[] scopes)
    {
        await using var work = await _fixture.Application.BeginUnitOfWorkAsync(principal, Cancellation);
        var result = await work.Resolve<NixDispatcher>().SendAsync<CreateAccessToken, IssuedAccessToken>(
            new CreateAccessToken(
                "transcription-http",
                scopes.Length == 0 ? [AccessTokenScopes.Read, AccessTokenScopes.Write] : scopes,
                1),
            Cancellation);
        Assert.True(result.IsSuccess, result.IsFailure ? result.Error.Message : string.Empty);
        await work.CommitAsync(Cancellation);
        using var exchange = await client.PostAsJsonAsync(
            "/public/v1/auth/token",
            new { token = result.Value.Secret },
            Cancellation);
        exchange.EnsureSuccessStatusCode();
        using var body = JsonDocument.Parse(await exchange.Content.ReadAsStringAsync(Cancellation));
        return body.RootElement.GetProperty("accessToken").GetString()!;
    }

    private async Task<HttpResponseMessage> SendAsync(HttpMethod method, string path, string bearer, object? body = null)
    {
        using var request = new HttpRequestMessage(method, path);
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", bearer);
        if (body is not null)
        {
            request.Content = JsonContent.Create(body);
        }
        return await _client.SendAsync(request, Cancellation);
    }

    private async Task<HttpResponseMessage> InternalAsync(
        HttpMethod method,
        string path,
        Guid jobId,
        string execution,
        object? body = null,
        string secret = InternalSecret)
    {
        using var request = new HttpRequestMessage(method, path);
        request.Headers.TryAddWithoutValidation(InternalBoundaryMiddleware.SecretHeaderName, secret);
        request.Headers.TryAddWithoutValidation(WorkerExecutionMiddleware.JobHeaderName, jobId.ToString("D"));
        request.Headers.TryAddWithoutValidation(WorkerExecutionMiddleware.ExecutionHeaderName, execution);
        if (body is not null)
        {
            request.Content = JsonContent.Create(body);
        }
        return await _client.SendAsync(request, Cancellation);
    }

    /// <summary>
    /// The same member names and, member for member, the same JSON value kind as the fixture the
    /// Go worker's own tests assert byte for byte.
    /// </summary>
    private static void AssertSameShape(JsonElement expected, JsonElement actual)
    {
        Assert.Equal(
            expected.EnumerateObject().Select(member => member.Name).Order(StringComparer.Ordinal),
            actual.EnumerateObject().Select(member => member.Name).Order(StringComparer.Ordinal));
        foreach (var member in expected.EnumerateObject())
        {
            Assert.True(
                member.Value.ValueKind == actual.GetProperty(member.Name).ValueKind,
                $"'{member.Name}' is {actual.GetProperty(member.Name).ValueKind}, the fixture has {member.Value.ValueKind}.");
        }
    }

    private static JsonElement Fixture(string name)
    {
        using var document = JsonDocument.Parse(FixtureText(name));
        return document.RootElement.Clone();
    }

    private static string FixtureText(string name) =>
        File.ReadAllText(Path.Combine(RepositoryRoot(), "apps", "go-workers", "internal", "workerapi", "testdata", "speech", name));

    private static string RepositoryRoot()
    {
        for (var directory = new DirectoryInfo(AppContext.BaseDirectory); directory is not null; directory = directory.Parent)
        {
            if (File.Exists(Path.Combine(directory.FullName, "Nix.slnx")))
            {
                return directory.FullName;
            }
        }

        throw new InvalidOperationException($"No Nix.slnx above {AppContext.BaseDirectory}.");
    }

    private static async Task<string?> ProblemCodeAsync(HttpResponseMessage response)
    {
        using var document = JsonDocument.Parse(await response.Content.ReadAsStringAsync(Cancellation));
        return document.RootElement.GetProperty("code").GetString();
    }

    private sealed class ConfiguredApplicationFactory(Dictionary<string, string?> settings) : WebApplicationFactory<Program>
    {
        protected override void ConfigureWebHost(Microsoft.AspNetCore.Hosting.IWebHostBuilder builder)
        {
            foreach (var (key, value) in settings)
            {
                builder.UseSetting(key, value);
            }
        }
    }
}
