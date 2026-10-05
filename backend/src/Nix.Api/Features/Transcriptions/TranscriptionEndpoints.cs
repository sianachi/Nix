using System.Text.Json;
using Microsoft.AspNetCore.Http.HttpResults;
using Microsoft.AspNetCore.Mvc;
using Nix.Abstractions;
using Nix.Abstractions.Files;
using Nix.Abstractions.Transcriptions;
using Nix.Abstractions.Workers;
using Nix.Domain.Items;
using Nix.Domain.Transcriptions;
using Nix.Domain.Workers;
using Nix.Errors;
using Nix.Http;
using Nix.Persistence.ObjectStorage;

namespace Nix.Features.Transcriptions;

/// <summary>
/// Starting, and reading the status of, the transcription of a recording (ADR-0059).
/// </summary>
/// <remarks>
/// A recording is an ordinary audio <c>file</c> item whose parent is a <c>note</c>. Core decides
/// who may have it transcribed, creates the job and answers for its status; the speech worker
/// does the transcribing and the collaboration service appends the result to the note.
/// </remarks>
internal static class TranscriptionEndpoints
{
    internal static IEndpointRouteBuilder MapTranscriptionEndpoints(this IEndpointRouteBuilder endpoints)
    {
        var transcription = endpoints.MapGroup("/api/v1/items/{itemId:guid}/transcription").WithTags("Transcriptions");
        transcription.MapPost("", Start)
            .WithName("StartItemTranscription")
            .Produces<TranscriptionResponse>(StatusCodes.Status202Accepted)
            .ProducesProblem(400)
            .ProducesProblem(404)
            .ProducesProblem(409)
            .ProducesProblem(503)
            .RequireRateLimiting(RateLimitRefusal.WritesPolicyName);
        transcription.MapGet("", Get)
            .WithName("GetItemTranscription")
            .Produces<TranscriptionResponse>()
            .ProducesProblem(404);
        return endpoints;
    }

    private static async Task<IResult> Start(
        Guid itemId,
        StartTranscriptionRequest request,
        HttpContext context,
        [FromServices] IItemTree tree,
        [FromServices] IPermissionResolver permissions,
        [FromServices] IItemLocks locks,
        [FromServices] IFileStore files,
        [FromServices] IWorkerJobStore jobs,
        [FromServices] IItemTranscriptionStore transcriptions,
        [FromServices] INixSessionContextAccessor session,
        [FromServices] AccessTokenSessionContext scope,
        [FromServices] S3CapabilitySigner signer)
    {
        if (!TranscriptionRules.ValidSpeakers(request.Speakers))
        {
            return TranscriptionProblems.Invalid(context, "The speakers mode must be 'channels' or 'none'.");
        }

        // Said at the button. Without a signer the worker could never be handed the audio, so the
        // job would be queued only to fail; this is a fact about the deployment, not about any
        // item, and tells the caller nothing they may not know.
        if (!signer.IsConfigured)
        {
            return TranscriptionProblems.StorageUnavailable(context);
        }

        var audioId = ItemId.From(itemId);
        var audio = await tree.FindAsync(audioId, context.RequestAborted).ConfigureAwait(false);
        if (audio is null
            || !await permissions.CanReadWorkspaceAsync(audio.WorkspaceId, context.RequestAborted).ConfigureAwait(false))
        {
            return TranscriptionProblems.NotFound(context);
        }

        // Shape before permission to write: these describe only the item the caller has just been
        // shown they can read, so saying "not a recording" discloses nothing they could not see.
        var note = audio is { Type: "file", ParentId: { } parentId }
            ? await tree.FindAsync(parentId, context.RequestAborted).ConfigureAwait(false)
            : null;
        if (note is not { Type: "note" })
        {
            return TranscriptionProblems.Unsupported(context);
        }

        // Transcribing writes into the note, so it needs what editing the note needs. Answered as
        // not found, like every other refused write: a reader learns nothing about what an editor
        // could do here. The token ceiling is checked as well as the route's scope, because this
        // start is what later lets the collaboration service write as this principal.
        if (!scope.MayWrite
            || !await permissions.CanWriteWorkspaceAsync(note.WorkspaceId, context.RequestAborted).ConfigureAwait(false))
        {
            return TranscriptionProblems.NotFound(context);
        }

        // A lock withholds a body, and this copies one body out (the audio) and writes another
        // (the note). Refused whenever any lock covers either - their own or an ancestor's - and
        // whatever this caller has unlocked: the job runs under a worker session and the append
        // under the collaboration service, and neither can hold the caller's unlock. Asking
        // whether the caller may read the body would let a start through that is certain to
        // surface minutes later as a failed job.
        var covered = await locks.LockedAmongAsync([audio.Id, note.Id], context.RequestAborted).ConfigureAwait(false);
        if (covered.Count != 0)
        {
            return TranscriptionProblems.Locked(context);
        }

        // The file store's own authorization, which is also where the media type is resolved: a
        // generically-typed upload with an audio extension is reported as audio here.
        var file = await files.AuthorizeDownloadAsync(audioId, null, context.RequestAborted).ConfigureAwait(false);
        if (file is null)
        {
            return TranscriptionProblems.NotFound(context);
        }
        if (!ServedAudio.IsServed(file.MediaType))
        {
            return TranscriptionProblems.Unsupported(context);
        }

        var scoped = session.Current
            ?? throw new InvalidOperationException("No session context; the pipeline must establish one.");

        // Two starts arriving together must not both find nothing running and each queue a job.
        await transcriptions.SerializeStartsAsync(audioId, context.RequestAborted).ConfigureAwait(false);
        var current = await transcriptions.FindAsync(audioId, context.RequestAborted).ConfigureAwait(false);
        if (current is not null && TranscriptionRules.Active(current.Status))
        {
            // Idempotent while work is in flight: the caller is told about the job that exists,
            // unchanged, even if this request asked for a different speakers mode.
            return Accepted(itemId, current);
        }

        var speakers = request.Speakers!;
        var payload = new TranscriptionJobPayload(itemId, note.Id.Value, speakers);

        // A fresh key per start, on purpose. The job store answers a reused key with the job it
        // already has, whatever its state, so a key derived from the item would return the failed
        // job for ever and a retry would never run. Deduplication is the check above instead.
        var job = await jobs.CreateAsync(
            scoped.TenantId,
            scoped.PrincipalId,
            audio.WorkspaceId,
            TranscriptionJob.Kind,
            $"transcribe:{itemId:N}:{Guid.CreateVersion7():N}",
            JsonSerializer.Serialize(payload, TranscriptionsJsonContext.Default.TranscriptionJobPayload),
            context.RequestAborted).ConfigureAwait(false);

        var jobId = WorkerJobId.From(job.Id);
        if (!await transcriptions.PointAtJobAsync(
            new StartedItemTranscription(
                audioId,
                audio.WorkspaceId,
                note.Id,
                jobId,
                speakers,
                scoped.PrincipalId),
            context.RequestAborted).ConfigureAwait(false))
        {
            // The recording was purged while this request was deciding. The refusal rolls the
            // unit of work back, and the job created a moment ago goes with it.
            return TranscriptionProblems.NotFound(context);
        }

        return Accepted(
            itemId,
            new ItemTranscriptionRecord(
                audioId,
                note.Id,
                audio.WorkspaceId,
                jobId,
                speakers,
                Progress: 0,
                job.Status,
                job.ErrorCode,
                job.CreatedAt,
                job.CompletedAt));
    }

    private static async Task<IResult> Get(
        Guid itemId,
        HttpContext context,
        [FromServices] IItemTree tree,
        [FromServices] IPermissionResolver permissions,
        [FromServices] IItemLocks locks,
        [FromServices] IItemTranscriptionStore transcriptions)
    {
        // Everything that could withhold the recording itself withholds its status, in the same
        // words: an item the caller cannot see, cannot read, or has not unlocked is "not found",
        // and so is a recording nobody has transcribed.
        var audioId = ItemId.From(itemId);
        var audio = await tree.FindAsync(audioId, context.RequestAborted).ConfigureAwait(false);
        if (audio is null
            || !await permissions.CanReadWorkspaceAsync(audio.WorkspaceId, context.RequestAborted).ConfigureAwait(false)
            || !await locks.MayReadBodyAsync(audioId, context.RequestAborted).ConfigureAwait(false))
        {
            return TranscriptionProblems.NotFound(context);
        }

        // Read by the audio item, not by the caller: the job store's own read is actor-only, and
        // a member who did not press the button must still see the bar move.
        var current = await transcriptions.FindAsync(audioId, context.RequestAborted).ConfigureAwait(false);

        // The row records the workspace the transcript was sent to. If the item is no longer in
        // it, the row names a note in a workspace this caller was not checked against, so it is
        // not reported.
        return current is null || current.WorkspaceId != audio.WorkspaceId
            ? TranscriptionProblems.NotFound(context)
            : TypedResults.Ok(TranscriptionRules.ToResponse(current));
    }

    private static Accepted<TranscriptionResponse> Accepted(Guid itemId, ItemTranscriptionRecord record) =>
        TypedResults.Accepted(
            $"/api/v1/items/{itemId:D}/transcription",
            TranscriptionRules.ToResponse(record));
}

/// <summary>The problem details every transcription route answers with.</summary>
internal static class TranscriptionProblems
{
    internal static ProblemHttpResult NotFound(HttpContext context) =>
        TypedResults.Problem(ApiProblem.Create(
            context,
            StatusCodes.Status404NotFound,
            "transcriptions.not_found",
            "Transcription not found",
            "No such recording or transcription is visible."));

    internal static ProblemHttpResult Unsupported(HttpContext context) =>
        TypedResults.Problem(ApiProblem.Create(
            context,
            StatusCodes.Status409Conflict,
            "transcriptions.unsupported",
            "Item cannot be transcribed",
            "Only an audio file placed directly inside a note can be transcribed."));

    internal static ProblemHttpResult Locked(HttpContext context) =>
        TypedResults.Problem(ApiProblem.Create(
            context,
            StatusCodes.Status409Conflict,
            "transcriptions.locked",
            "Recording or note is locked",
            "A lock covers the recording or its note. Remove the lock before transcribing."));

    internal static ProblemHttpResult Invalid(HttpContext context, string detail) =>
        TypedResults.Problem(ApiProblem.Create(
            context,
            StatusCodes.Status400BadRequest,
            "transcriptions.invalid",
            "Transcription request invalid",
            detail));

    internal static ProblemHttpResult StorageUnavailable(HttpContext context) =>
        TypedResults.Problem(ApiProblem.Create(
            context,
            StatusCodes.Status503ServiceUnavailable,
            "transcriptions.storage_not_configured",
            "Recording storage unavailable",
            "Private object storage is not configured for this deployment."));
}
