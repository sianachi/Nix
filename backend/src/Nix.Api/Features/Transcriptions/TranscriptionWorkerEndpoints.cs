using System.Text.Json;
using Microsoft.AspNetCore.Http.HttpResults;
using Microsoft.AspNetCore.Mvc;
using Nix.Abstractions;
using Nix.Abstractions.Files;
using Nix.Abstractions.Transcriptions;
using Nix.Abstractions.Workers;
using Nix.Authentication;
using Nix.Domain.Items;
using Nix.Domain.Tenancy;
using Nix.Domain.Transcriptions;
using Nix.Domain.Workers;
using Nix.Persistence.ObjectStorage;

namespace Nix.Features.Transcriptions;

/// <summary>
/// The worker side of a transcription: what the speech worker and the collaboration service may
/// ask Core while they hold the job's lease.
/// </summary>
/// <remarks>
/// <para>
/// No route carries an identifier. <see cref="WorkerExecutionMiddleware"/> has already proved the
/// caller owns the live lease of the job its headers name and has set the session to that job's
/// tenant, workspace and actor; the audio item and the note come from the job's own payload,
/// which Core wrote. A path the worker could fill in would be a second, weaker statement of the
/// same fact.
/// </para>
/// <para>
/// Every answer is re-derived as the job's actor at the moment it is asked. The start endpoint's
/// checks are minutes old by the time a long recording is transcribed: the actor may have lost
/// the workspace, the note may have been deleted, a lock may have been set. Each of those reads
/// as 404 here, the same non-answer the public surface gives.
/// </para>
/// </remarks>
internal static class TranscriptionWorkerEndpoints
{
    internal static void MapWorkerExecutions(IEndpointRouteBuilder group)
    {
        var transcriptions = group.MapGroup("/transcriptions");
        transcriptions.MapGet("/source", GetSource);
        transcriptions.MapPost("/progress", ReportProgress);
        transcriptions.MapGet("/authorization", AuthorizeAppend);
    }

    private static async Task<IResult> GetSource(
        HttpContext context,
        [FromServices] IWorkerJobStore jobs,
        [FromServices] INixSessionContextAccessor session,
        [FromServices] IItemTree tree,
        [FromServices] IPermissionResolver permissions,
        [FromServices] IFileStore files,
        [FromServices] S3CapabilitySigner signer,
        [FromServices] ILoggerFactory loggers)
    {
        const string route = "source";
        if (!signer.IsConfigured)
        {
            return TranscriptionProblems.StorageUnavailable(context);
        }
        var logger = loggers.CreateLogger(TranscriptionLog.Category);
        var execution = await OwnedExecution(route, context, jobs, session, logger).ConfigureAwait(false);
        if (execution is null)
        {
            return TranscriptionProblems.NotFound(context);
        }

        var file = await ReadableAudio(route, execution, tree, files, logger, context.RequestAborted).ConfigureAwait(false);
        if (file is null)
        {
            return TranscriptionProblems.NotFound(context);
        }
        if (file.ByteLength <= 0 || !ServedAudio.IsServed(file.MediaType))
        {
            return Refuse(route, execution, logger, context, "the file is empty or no longer an audio type");
        }

        // No point handing out the audio for a transcript that can no longer be delivered.
        if (await WritableNote(route, execution, tree, permissions, logger, context.RequestAborted).ConfigureAwait(false) is null)
        {
            return TranscriptionProblems.NotFound(context);
        }

        return TypedResults.Ok(new WorkerTranscriptionSourceResponse(
            signer.Get(file.ObjectKey).Url,
            file.ByteLength,
            execution.AudioItemId.Value,
            execution.NoteItemId.Value,
            execution.WorkspaceId.Value,
            execution.Speakers));
    }

    private static async Task<IResult> ReportProgress(
        WorkerTranscriptionProgressRequest request,
        HttpContext context,
        [FromServices] IWorkerJobStore jobs,
        [FromServices] INixSessionContextAccessor session,
        [FromServices] IItemTranscriptionStore transcriptions,
        [FromServices] ILoggerFactory loggers)
    {
        if (!TranscriptionRules.ValidPercent(request.Percent))
        {
            return TranscriptionProblems.Invalid(context, "The percentage must be between 0 and 100.");
        }
        var execution = await OwnedExecution(
            "progress",
            context,
            jobs,
            session,
            loggers.CreateLogger(TranscriptionLog.Category)).ConfigureAwait(false);
        if (execution is null)
        {
            return TranscriptionProblems.NotFound(context);
        }

        // Applied only while the row still names this job, and never downwards. A live lease on a
        // superseded job is possible - the row was repointed after this job failed over - and its
        // reports are accepted and dropped: there is nothing the worker could do with a refusal.
        await transcriptions.ReportProgressAsync(
            execution.AudioItemId,
            execution.JobId,
            request.Percent,
            context.RequestAborted).ConfigureAwait(false);
        return TypedResults.NoContent();
    }

    private static async Task<IResult> AuthorizeAppend(
        HttpContext context,
        [FromServices] IWorkerJobStore jobs,
        [FromServices] INixSessionContextAccessor session,
        [FromServices] IItemTree tree,
        [FromServices] IPermissionResolver permissions,
        [FromServices] IFileStore files,
        [FromServices] ILoggerFactory loggers)
    {
        const string route = "authorization";
        var logger = loggers.CreateLogger(TranscriptionLog.Category);
        var execution = await OwnedExecution(route, context, jobs, session, logger).ConfigureAwait(false);
        if (execution is null
            || await WritableNote(route, execution, tree, permissions, logger, context.RequestAborted).ConfigureAwait(false) is null)
        {
            return TranscriptionProblems.NotFound(context);
        }

        // A transcript is the recording's body in another form. If the actor can no longer read
        // the recording, or a lock has been put on it since the job started, writing its words
        // into an unlocked note would carry them straight past that lock. So the append is
        // authorized by the same check that hands out the bytes, and a worker session, holding
        // no unlock, is refused by any lock at all.
        var file = await ReadableAudio(route, execution, tree, files, logger, context.RequestAborted).ConfigureAwait(false);
        if (file is null)
        {
            return TranscriptionProblems.NotFound(context);
        }

        return TypedResults.Ok(new WorkerTranscriptionAuthorizationResponse(
            execution.TenantId.Value,
            execution.ActorId.Value,
            execution.WorkspaceId.Value,
            execution.NoteItemId.Value,
            execution.AudioItemId.Value,
            TranscriptionRules.AudioTitle(ItemProperties.ReadTitle(file.Audio.Properties), file.FileName),
            CanWrite: true));
    }

    /// <summary>
    /// The recording's current file, if it is still in the job's workspace and the job's actor
    /// may still read its bytes.
    /// </summary>
    /// <remarks>
    /// The tree read pins the item to the job's workspace; the file store then applies the read
    /// permission and the lock as the job's actor. A worker session holds no unlock, so a
    /// recording locked since the start is refused here, which is the intended outcome: neither
    /// the bytes of a locked item nor a transcript of them leave for a worker.
    /// </remarks>
    private static async ValueTask<ReadableRecording?> ReadableAudio(
        string route,
        TranscriptionExecution execution,
        IItemTree tree,
        IFileStore files,
        ILogger logger,
        CancellationToken cancellationToken)
    {
        var audio = await tree.FindAsync(execution.AudioItemId, cancellationToken).ConfigureAwait(false);
        if (audio is null || audio.WorkspaceId != execution.WorkspaceId)
        {
            TranscriptionLog.Refused(logger, route, execution.JobId.Value, execution.TenantId.Value, "the recording is gone or has left the job's workspace");
            return null;
        }
        var file = await files.AuthorizeDownloadAsync(execution.AudioItemId, null, cancellationToken).ConfigureAwait(false);
        if (file is null)
        {
            TranscriptionLog.Refused(logger, route, execution.JobId.Value, execution.TenantId.Value, "the recording is locked, unreadable by the job's actor, or has no stored file");
            return null;
        }
        return new ReadableRecording(audio, file.ObjectKey, file.FileName, file.MediaType, file.ByteLength);
    }

    /// <summary>
    /// The note the transcript goes to, if it is still a note in the job's workspace that the
    /// job's actor may write.
    /// </summary>
    private static async ValueTask<Item?> WritableNote(
        string route,
        TranscriptionExecution execution,
        IItemTree tree,
        IPermissionResolver permissions,
        ILogger logger,
        CancellationToken cancellationToken)
    {
        var note = await tree.FindAsync(execution.NoteItemId, cancellationToken).ConfigureAwait(false);
        if (note is not { Type: "note" } || note.WorkspaceId != execution.WorkspaceId)
        {
            TranscriptionLog.Refused(logger, route, execution.JobId.Value, execution.TenantId.Value, "the note is gone, is no longer a note, or has left the job's workspace");
            return null;
        }
        if (!await permissions.CanWriteWorkspaceAsync(note.WorkspaceId, cancellationToken).ConfigureAwait(false))
        {
            TranscriptionLog.Refused(logger, route, execution.JobId.Value, execution.TenantId.Value, "the job's actor may no longer write the note's workspace");
            return null;
        }
        return note;
    }

    /// <summary>
    /// The running <c>transcribe.audio</c> job the execution headers name, with its payload.
    /// </summary>
    /// <remarks>
    /// The middleware proved the lease; this proves the lease is for this kind of work. Without
    /// the kind check any leased job - an export, a cleanup - could ask for a recording's bytes by
    /// arriving with a payload that happened to carry the right field names.
    /// </remarks>
    private static async ValueTask<TranscriptionExecution?> OwnedExecution(
        string route,
        HttpContext context,
        IWorkerJobStore jobs,
        INixSessionContextAccessor session,
        ILogger logger)
    {
        if (!Guid.TryParse(context.Request.Headers[WorkerExecutionMiddleware.JobHeaderName], out var jobId))
        {
            return null;
        }
        var scoped = session.Current
            ?? throw new InvalidOperationException("No session context; the pipeline must establish one.");
        var job = await jobs.GetAsync(
            scoped.TenantId,
            scoped.PrincipalId,
            jobId,
            context.RequestAborted).ConfigureAwait(false);
        if (job is not { Kind: TranscriptionJob.Kind, Status: "running" }
            || scoped.WorkspaceId is not { } workspaceId)
        {
            TranscriptionLog.Refused(logger, route, jobId, scoped.TenantId.Value, "the leased job is not a running transcription in a workspace");
            return null;
        }

        TranscriptionJobPayload? payload;
        try
        {
            payload = JsonSerializer.Deserialize(
                job.Payload,
                TranscriptionsJsonContext.Default.TranscriptionJobPayload);
        }
        catch (JsonException exception)
        {
            TranscriptionLog.PayloadUnreadable(logger, jobId, scoped.TenantId.Value, exception);
            return null;
        }
        if (payload is null
            || payload.AudioItemId == Guid.Empty
            || payload.NoteItemId == Guid.Empty
            || !TranscriptionRules.ValidSpeakers(payload.Speakers))
        {
            TranscriptionLog.PayloadUnreadable(logger, jobId, scoped.TenantId.Value, exception: null);
            return null;
        }

        return new TranscriptionExecution(
            WorkerJobId.From(jobId),
            scoped.TenantId,
            workspaceId,
            scoped.PrincipalId,
            ItemId.From(payload.AudioItemId),
            ItemId.From(payload.NoteItemId),
            payload.Speakers);
    }

    private static ProblemHttpResult Refuse(
        string route,
        TranscriptionExecution execution,
        ILogger logger,
        HttpContext context,
        string reason)
    {
        TranscriptionLog.Refused(logger, route, execution.JobId.Value, execution.TenantId.Value, reason);
        return TranscriptionProblems.NotFound(context);
    }

    private sealed record TranscriptionExecution(
        WorkerJobId JobId,
        TenantId TenantId,
        WorkspaceId WorkspaceId,
        Nix.Domain.Identity.PrincipalId ActorId,
        ItemId AudioItemId,
        ItemId NoteItemId,
        string Speakers);

    private sealed record ReadableRecording(
        Item Audio,
        string ObjectKey,
        string FileName,
        string MediaType,
        long ByteLength);
}
