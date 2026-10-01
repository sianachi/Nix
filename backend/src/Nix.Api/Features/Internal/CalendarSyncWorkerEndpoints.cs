using System.Text.Json;
using System.Text.Json.Serialization.Metadata;
using Microsoft.AspNetCore.Mvc;
using Nix.Abstractions;
using Nix.Abstractions.Calendar;
using Nix.Abstractions.Workers;
using Nix.Authentication;
using Nix.Domain.Calendar;
using Nix.Domain.Items;
using Nix.Errors;
using Nix.Features.CalendarSync;
using Nix.Http;

namespace Nix.Features.Internal;

/// <summary>
/// C1-C6: the worker-execution routes a <c>calendar.sync</c> job drives (ADR-0052 steps 1-5,
/// Amendment 1 A6). Guarded by <see cref="WorkerExecutionMiddleware"/>: tenant, workspace and actor
/// come only from the leased job, and every route further requires that the job is this link's own
/// running <c>calendar.sync</c> job - the one last recorded on the link - in the link's workspace,
/// and that the owner can still write the unlocked container. Anything else is 409
/// <c>calendar.link_unavailable</c>, which the worker treats as terminal; a malformed body is 400
/// <c>calendar.request_invalid</c>.
/// </summary>
/// <remarks>
/// A map write that loses a race for the map's pairing indexes anyway
/// (<see cref="CalendarPairingConflictException"/>) is answered with the same terminal 409: the execution's transaction is already aborted, and the next round
/// starts from what is committed.
/// </remarks>
internal static class CalendarSyncWorkerEndpoints
{
    /// <summary>The terminal refusal.</summary>
    internal const string LinkUnavailableCode = "calendar.link_unavailable";

    /// <summary>The shape refusal.</summary>
    internal const string RequestInvalidCode = "calendar.request_invalid";

    /// <summary>C2's body bound: 100 events with 8000-character details can pass 256 KiB.</summary>
    internal const long PullBodyLimit = 2L * 1024 * 1024;

    internal static void MapWorkerExecutions(IEndpointRouteBuilder group)
    {
        var links = group.MapGroup("/calendar/links/{linkId:guid}");
        links.MapPost("/session", Session);
        links.MapPost("/pull", Pull).WithRequestBodyLimit(PullBodyLimit);
        links.MapGet("/changes", Changes);
        links.MapPost("/pushed", Pushed);
        links.MapPost("/cursor", Cursor);
        links.MapPost("/log", Log);
    }

    private static async Task<IResult> Session(
        Guid linkId,
        HttpContext context,
        [FromServices] CalendarWorkerGuard guard,
        [FromServices] ICalendarSyncStore store,
        [FromServices] CalendarAccessTokens tokens,
        [FromServices] INixSessionContextAccessor session,
        [FromServices] TimeProvider clock)
    {
        var resolved = await guard.ResolveAsync(linkId, context).ConfigureAwait(false);
        if (resolved is not { } bound)
        {
            return Unavailable(context);
        }

        var link = bound.Link;
        var connection = await store.GetConnectionAsync(link.ConnectionId, context.RequestAborted).ConfigureAwait(false);
        if (connection is null || connection.Status == "revoked")
        {
            return Unavailable(context);
        }

        var (windowStart, windowEnd) = CalendarSyncRules.Window(clock.GetUtcNow(), link.WindowPastDays, link.WindowFutureDays);
        var cursor = CalendarSyncRules.RequiresFullResync(
            bound.Full, link.SyncCursor, link.CursorWindowStart, link.CursorWindowEnd, windowStart, windowEnd)
            ? null
            : link.SyncCursor;

        var access = await tokens.AcquireAsync(session.Current!.Value, connection.Id, link.WorkspaceId, context.RequestAborted)
            .ConfigureAwait(false);
        return access.Status switch
        {
            CalendarAccessStatus.Ok => Json(new CalendarSessionResponse(
                connection.Provider,
                link.ExternalCalendarId,
                link.Direction,
                cursor,
                windowStart,
                windowEnd,
                access.AccessToken!,
                access.ExpiresAt!.Value), CalendarWorkerJsonContext.Default.CalendarSessionResponse),
            CalendarAccessStatus.NeedsReauth => Problem(
                context, StatusCodes.Status409Conflict, CalendarSyncErrors.NeedsReauthCode, "The calendar account must be reconnected."),
            CalendarAccessStatus.ProviderUnavailable => Problem(
                context, StatusCodes.Status503ServiceUnavailable, CalendarSyncErrors.ProviderUnavailableCode, "The calendar provider is unavailable."),
            _ => Unavailable(context),
        };
    }

    private static async Task<IResult> Pull(
        Guid linkId,
        HttpContext context,
        [FromServices] CalendarWorkerGuard guard,
        [FromServices] CalendarSyncEngine engine)
    {
        var request = await ReadAsync(context, CalendarWorkerJsonContext.Default.CalendarPullRequest).ConfigureAwait(false);
        if (request is null || CalendarSyncEngine.ValidatePull(request) is not null)
        {
            return Invalid(context);
        }

        if (await guard.ResolveAsync(linkId, context).ConfigureAwait(false) is not { } bound)
        {
            return Unavailable(context);
        }

        return await ContainedAsync(context, async () => Json(
            await engine.PullAsync(bound.Link, request, CalendarWorkerGuard.ExecutionId(context), context.RequestAborted).ConfigureAwait(false),
            CalendarWorkerJsonContext.Default.CalendarPullResponse)).ConfigureAwait(false);
    }

    private static async Task<IResult> Changes(
        Guid linkId,
        HttpContext context,
        [FromServices] CalendarWorkerGuard guard,
        [FromServices] CalendarSyncEngine engine)
    {
        if (!int.TryParse(context.Request.Query["limit"], System.Globalization.NumberStyles.None, System.Globalization.CultureInfo.InvariantCulture, out var limit)
            || limit is < 1 or > 100)
        {
            return Invalid(context);
        }

        if (await guard.ResolveAsync(linkId, context).ConfigureAwait(false) is not { } bound)
        {
            return Unavailable(context);
        }

        return await ContainedAsync(context, async () => Json(
            await engine.ChangesAsync(bound.Link, limit, context.RequestAborted).ConfigureAwait(false),
            CalendarWorkerJsonContext.Default.CalendarChangesResponse)).ConfigureAwait(false);
    }

    private static async Task<IResult> Pushed(
        Guid linkId,
        HttpContext context,
        [FromServices] CalendarWorkerGuard guard,
        [FromServices] CalendarSyncEngine engine)
    {
        var request = await ReadAsync(context, CalendarWorkerJsonContext.Default.CalendarPushedRequest).ConfigureAwait(false);
        if (request is null || CalendarSyncEngine.ValidatePushed(request) is not null)
        {
            return Invalid(context);
        }

        if (await guard.ResolveAsync(linkId, context).ConfigureAwait(false) is not { } bound)
        {
            return Unavailable(context);
        }

        return await ContainedAsync(context, async () =>
        {
            await engine.PushedAsync(bound.Link, request, context.RequestAborted).ConfigureAwait(false);
            return Results.NoContent();
        }).ConfigureAwait(false);
    }

    private static async Task<IResult> Cursor(
        Guid linkId,
        HttpContext context,
        [FromServices] CalendarWorkerGuard guard,
        [FromServices] CalendarSyncEngine engine)
    {
        var request = await ReadAsync(context, CalendarWorkerJsonContext.Default.CalendarCursorRequest).ConfigureAwait(false);
        if (request is null
            || request.Cursor.Length > CalendarSyncRules.MaxVersionLength
            || request.WindowEnd <= request.WindowStart)
        {
            return Invalid(context);
        }

        if (await guard.ResolveAsync(linkId, context).ConfigureAwait(false) is not { } bound)
        {
            return Unavailable(context);
        }

        return await ContainedAsync(context, async () =>
        {
            await engine.CursorAsync(bound.Link, request, CalendarWorkerGuard.ExecutionId(context), bound.Full, context.RequestAborted)
                .ConfigureAwait(false);
            return Results.NoContent();
        }).ConfigureAwait(false);
    }

    private static async Task<IResult> Log(
        Guid linkId,
        HttpContext context,
        [FromServices] CalendarWorkerGuard guard,
        [FromServices] CalendarSyncEngine engine)
    {
        var request = await ReadAsync(context, CalendarWorkerJsonContext.Default.CalendarLogRequest).ConfigureAwait(false);
        if (request is null || CalendarSyncEngine.ValidateLog(request) is not null)
        {
            return Invalid(context);
        }

        if (await guard.ResolveAsync(linkId, context).ConfigureAwait(false) is not { } bound)
        {
            return Unavailable(context);
        }

        await engine.LogAsync(bound.Link, request, context.RequestAborted).ConfigureAwait(false);
        return Results.NoContent();
    }

    private static async Task<T?> ReadAsync<T>(HttpContext context, JsonTypeInfo<T> typeInfo)
        where T : class
    {
        if (context.Request.ContentType is not { } contentType
            || !contentType.StartsWith("application/json", StringComparison.OrdinalIgnoreCase))
        {
            return null;
        }

        try
        {
            return await JsonSerializer.DeserializeAsync(context.Request.Body, typeInfo, context.RequestAborted).ConfigureAwait(false);
        }
        catch (JsonException)
        {
            return null;
        }
    }

    private static async Task<IResult> ContainedAsync(HttpContext context, Func<Task<IResult>> work)
    {
        try
        {
            return await work().ConfigureAwait(false);
        }
        catch (CalendarPairingConflictException)
        {
            return Unavailable(context);
        }
    }

    private static IResult Json<T>(T value, JsonTypeInfo<T> typeInfo) => Results.Json(value, typeInfo);

    private static IResult Unavailable(HttpContext context) => Problem(
        context, StatusCodes.Status409Conflict, LinkUnavailableCode, "The calendar link is not available to this worker execution.");

    private static IResult Invalid(HttpContext context) => Problem(
        context, StatusCodes.Status400BadRequest, RequestInvalidCode, "The calendar worker request is malformed.");

    private static IResult Problem(HttpContext context, int status, string code, string detail) =>
        Results.Problem(ApiProblem.Create(context, status, code, "Calendar sync request refused", detail));
}

/// <summary>
/// The C1-C6 guard (modelled on N1's job resolution): the job named by the execution headers must
/// be this link's own running <c>calendar.sync</c> job in the link's workspace, and the job last
/// recorded on the link, so two rounds of one link never run at once; the link must be the
/// session owner's, active or paused (so an in-flight job can finish); and the owner must still be
/// able to write the container, which no lock covers.
/// </summary>
public sealed class CalendarWorkerGuard(
    IWorkerJobStore jobs,
    ICalendarSyncStore store,
    INixSessionContextAccessor session,
    IPermissionResolver permissions,
    IItemTree tree,
    IItemLocks locks)
{
    /// <summary>The execution id the middleware already validated against the lease.</summary>
    internal static string ExecutionId(HttpContext context) =>
        context.Request.Headers[WorkerExecutionMiddleware.ExecutionHeaderName].ToString();

    /// <summary>Resolves the link this execution may act on, or <see langword="null"/>.</summary>
    public async Task<CalendarWorkerBinding?> ResolveAsync(Guid linkId, HttpContext context)
    {
        ArgumentNullException.ThrowIfNull(context);
        var cancellationToken = context.RequestAborted;
        if (!Guid.TryParse(context.Request.Headers[WorkerExecutionMiddleware.JobHeaderName].ToString(), out var jobId)
            || session.Current is not { } scoped)
        {
            return null;
        }

        var job = await jobs.GetAsync(scoped.TenantId, scoped.PrincipalId, jobId, cancellationToken).ConfigureAwait(false);
        if (job is not { Kind: CalendarSyncRules.JobKind, Status: "running" })
        {
            return null;
        }

        CalendarSyncJobPayload? payload;
        try
        {
            payload = JsonSerializer.Deserialize(job.Payload, CalendarWorkerJsonContext.Default.CalendarSyncJobPayload);
        }
        catch (JsonException)
        {
            return null;
        }

        if (payload is null || payload.LinkId != linkId)
        {
            return null;
        }

        var link = await store.GetLinkAsync(linkId, cancellationToken).ConfigureAwait(false);
        if (link is null
            || link.LastJobId != jobId
            || scoped.WorkspaceId != link.WorkspaceId
            || link.Status is not ("active" or "paused")
            || !await permissions.CanWriteWorkspaceAsync(link.WorkspaceId, cancellationToken).ConfigureAwait(false))
        {
            return null;
        }

        var container = await tree.FindAsync(link.ContainerItemId, cancellationToken).ConfigureAwait(false);
        if (container is null || container.LifecycleState != ItemLifecycleState.Active || container.WorkspaceId != link.WorkspaceId
            || (await locks.LockedAmongAsync([container.Id], cancellationToken).ConfigureAwait(false)).Contains(container.Id))
        {
            return null;
        }

        return new CalendarWorkerBinding(link, payload.Full);
    }
}

/// <summary>A resolved link and whether its job asked for a full resync.</summary>
public readonly record struct CalendarWorkerBinding(CalendarLink Link, bool Full);
