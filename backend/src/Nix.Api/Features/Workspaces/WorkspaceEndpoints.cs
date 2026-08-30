using Microsoft.AspNetCore.Http.HttpResults;
using Microsoft.AspNetCore.Mvc;
using Nix.Contracts;
using Nix.Domain.Primitives;
using Nix.Domain.Tenancy;
using Nix.Errors;
using Nix.Http;
using Nix.Messaging;
using Nix.Persistence.Workspaces;

namespace Nix.Features.Workspaces;

/// <summary>
/// Route registration for the workspaces feature.
/// </summary>
/// <remarks>
/// Contract only: the shapes and the failure codes are real and stable, the bodies are not built.
/// See <see cref="ContractStub"/> for why that is a deliberate delivery step rather than an
/// unfinished one.
/// </remarks>
internal static class WorkspaceEndpoints
{
    /// <summary>Stable code for "no such workspace, or the caller cannot see it".</summary>
    internal const string NotFoundCode = "workspaces.not_found";

    /// <summary>
    /// Registers the workspaces feature's routes on <paramref name="endpoints"/>.
    /// </summary>
    internal static IEndpointRouteBuilder MapWorkspaceEndpoints(this IEndpointRouteBuilder endpoints)
    {
        ArgumentNullException.ThrowIfNull(endpoints);

        var workspaces = endpoints.MapGroup("/api/v1/workspaces")
            .WithTags("Workspaces");

        workspaces.MapGet("/", ListWorkspacesEndpoint.Handle)
            .WithName("ListWorkspaces")
            .WithSummary("Workspaces the caller can see")
            .WithDescription(
                "Returns the workspaces the calling principal is a member of, newest first. "
                + "Workspaces the caller cannot see are omitted entirely rather than redacted: a "
                + "list is how you enumerate what exists, so a placeholder would leak the fact of "
                + "them.")
            .Produces<CursorPage<WorkspaceResponse>>(StatusCodes.Status200OK)
            .ProducesProblem(StatusCodes.Status422UnprocessableEntity);

        workspaces.MapGet("/{workspaceId:guid}", GetWorkspaceEndpoint.Handle)
            .WithName("GetWorkspace")
            .WithSummary("One workspace")
            .WithDescription(
                "Returns the workspace, or a problem with code 'workspaces.not_found'. A workspace "
                + "the caller may not see is reported as not found rather than as forbidden, so "
                + "the response cannot be used to confirm that it exists.")
            .Produces<WorkspaceResponse>(StatusCodes.Status200OK)
            .ProducesProblem(StatusCodes.Status404NotFound);

        workspaces.MapPost(string.Empty, CreateWorkspaceEndpoint.Handle)
            .WithName("CreateWorkspace")
            .Produces<WorkspaceResponse>(StatusCodes.Status201Created)
            .ProducesProblem(StatusCodes.Status403Forbidden)
            .ProducesProblem(StatusCodes.Status422UnprocessableEntity)
            .RequireRateLimiting(RateLimitRefusal.WritesPolicyName);

        workspaces.MapPatch("/{workspaceId:guid}", RenameWorkspaceEndpoint.Handle)
            .WithName("RenameWorkspace")
            .Produces<WorkspaceResponse>(StatusCodes.Status200OK)
            .ProducesProblem(StatusCodes.Status404NotFound)
            .ProducesProblem(StatusCodes.Status422UnprocessableEntity)
            .RequireRateLimiting(RateLimitRefusal.WritesPolicyName);

        workspaces.MapGet("/{workspaceId:guid}/members", WorkspaceAdministrationEndpoints.ListMembers)
            .WithName("ListWorkspaceMembers")
            .Produces<CursorPage<WorkspaceMemberResponse>>(StatusCodes.Status200OK)
            .ProducesProblem(StatusCodes.Status422UnprocessableEntity);
        workspaces.MapGet("/{workspaceId:guid}/invitees", WorkspaceAdministrationEndpoints.ListInvitees)
            .WithName("ListWorkspaceInvitees")
            .Produces<CursorPage<WorkspaceInviteeResponse>>(StatusCodes.Status200OK)
            .ProducesProblem(StatusCodes.Status422UnprocessableEntity);
        workspaces.MapPatch("/{workspaceId:guid}/members/{principalId:guid}", WorkspaceAdministrationEndpoints.ChangeMember)
            .WithName("ChangeWorkspaceMemberRole")
            .Produces<WorkspaceMemberResponse>(StatusCodes.Status200OK)
            .ProducesProblem(StatusCodes.Status404NotFound)
            .ProducesProblem(StatusCodes.Status409Conflict)
            .ProducesProblem(StatusCodes.Status422UnprocessableEntity)
            .RequireRateLimiting(RateLimitRefusal.WritesPolicyName);
        workspaces.MapDelete("/{workspaceId:guid}/members/{principalId:guid}", WorkspaceAdministrationEndpoints.RemoveMember)
            .WithName("RemoveWorkspaceMember")
            .Produces(StatusCodes.Status204NoContent)
            .ProducesProblem(StatusCodes.Status404NotFound)
            .ProducesProblem(StatusCodes.Status409Conflict)
            .RequireRateLimiting(RateLimitRefusal.WritesPolicyName);
        workspaces.MapPost("/{workspaceId:guid}/leave", WorkspaceAdministrationEndpoints.Leave)
            .WithName("LeaveWorkspace")
            .Produces(StatusCodes.Status204NoContent)
            .ProducesProblem(StatusCodes.Status404NotFound)
            .ProducesProblem(StatusCodes.Status409Conflict)
            .RequireRateLimiting(RateLimitRefusal.WritesPolicyName);

        workspaces.MapGet("/{workspaceId:guid}/invitations", WorkspaceAdministrationEndpoints.ListInvitations)
            .WithName("ListWorkspaceInvitations")
            .Produces<CursorPage<WorkspaceInvitationResponse>>(StatusCodes.Status200OK)
            .ProducesProblem(StatusCodes.Status422UnprocessableEntity);
        workspaces.MapPost("/{workspaceId:guid}/invitations", WorkspaceAdministrationEndpoints.Invite)
            .WithName("CreateWorkspaceInvitation")
            .Produces<WorkspaceInvitationResponse>(StatusCodes.Status201Created)
            .ProducesProblem(StatusCodes.Status404NotFound)
            .ProducesProblem(StatusCodes.Status409Conflict)
            .ProducesProblem(StatusCodes.Status422UnprocessableEntity)
            .RequireRateLimiting(RateLimitRefusal.WritesPolicyName);
        workspaces.MapDelete("/{workspaceId:guid}/invitations/{invitationId:guid}", WorkspaceAdministrationEndpoints.RevokeInvitation)
            .WithName("RevokeWorkspaceInvitation")
            .Produces(StatusCodes.Status204NoContent)
            .ProducesProblem(StatusCodes.Status404NotFound)
            .ProducesProblem(StatusCodes.Status409Conflict)
            .RequireRateLimiting(RateLimitRefusal.WritesPolicyName);
        workspaces.MapPost("/{workspaceId:guid}/invitations/{invitationId:guid}/accept", WorkspaceAdministrationEndpoints.AcceptInvitation)
            .WithName("AcceptWorkspaceInvitation")
            .Produces(StatusCodes.Status204NoContent)
            .ProducesProblem(StatusCodes.Status404NotFound)
            .RequireRateLimiting(RateLimitRefusal.WritesPolicyName);
        workspaces.MapPost("/{workspaceId:guid}/invitations/{invitationId:guid}/decline", WorkspaceAdministrationEndpoints.DeclineInvitation)
            .WithName("DeclineWorkspaceInvitation")
            .Produces(StatusCodes.Status204NoContent)
            .ProducesProblem(StatusCodes.Status404NotFound)
            .RequireRateLimiting(RateLimitRefusal.WritesPolicyName);
        workspaces.MapPost("/{workspaceId:guid}/recover", WorkspaceAdministrationEndpoints.Recover)
            .WithName("RecoverWorkspace")
            .Produces<WorkspaceResponse>(StatusCodes.Status200OK)
            .ProducesProblem(StatusCodes.Status403Forbidden)
            .ProducesProblem(StatusCodes.Status404NotFound)
            .ProducesProblem(StatusCodes.Status409Conflict)
            .RequireRateLimiting(RateLimitRefusal.WritesPolicyName);
        workspaces.MapPut("/{workspaceId:guid}/daily-notes/{date}", OpenDailyNoteEndpoint.Handle)
            .WithName("OpenDailyNote")
            .Produces<DailyNoteResponse>(StatusCodes.Status200OK)
            .ProducesProblem(StatusCodes.Status404NotFound)
            .ProducesProblem(StatusCodes.Status422UnprocessableEntity)
            .RequireRateLimiting(RateLimitRefusal.WritesPolicyName);

        return endpoints;
    }

    internal static WorkspaceResponse ToResponse(WorkspaceSnapshot row) => new(
        row.Id.Value, row.Name, row.VersionRetentionDays, row.StorageQuotaBytes, row.CreatedAt,
        row.PersonalOwnerPrincipalId is null ? "shared" : "personal",
        row.CanRename, row.CanManageMembers, row.CanLeave, row.PendingInvitationId);

    internal static Microsoft.AspNetCore.Mvc.ProblemDetails Problem(HttpContext context, NixError error)
    {
        var status = error.Code switch
        {
            NotFoundCode => StatusCodes.Status404NotFound,
            "workspaces.invalid_name" or
            "workspaces.invalid_invitation" or
            "workspaces.invalid_role" or
            "workspaces.invalid_daily_date" or
            "paging.invalid_cursor" => StatusCodes.Status422UnprocessableEntity,
            "workspaces.human_required" => StatusCodes.Status403Forbidden,
            "workspaces.recovery_forbidden" => StatusCodes.Status403Forbidden,
            _ => StatusCodes.Status409Conflict,
        };
        return ApiProblem.Create(context, status, error.Code, "Workspace request refused", error.Message);
    }
}

internal static class OpenDailyNoteEndpoint
{
    internal static async Task<Results<Ok<DailyNoteResponse>, ProblemHttpResult>> Handle(
        Guid workspaceId, string date, HttpContext context, [FromServices] NixDispatcher dispatcher)
    {
        var result = await dispatcher.SendAsync<OpenDailyNote, Guid>(
            new OpenDailyNote(WorkspaceId.From(workspaceId), date), context.RequestAborted)
            .ConfigureAwait(false);
        return result.Match<Results<Ok<DailyNoteResponse>, ProblemHttpResult>>(
            itemId => TypedResults.Ok(new DailyNoteResponse(itemId)),
            error => TypedResults.Problem(WorkspaceEndpoints.Problem(context, error)));
    }
}

internal static class ListWorkspacesEndpoint
{
    internal static async Task<Results<Ok<CursorPage<WorkspaceResponse>>, ProblemHttpResult>> Handle(
        HttpContext context,
        [FromServices] NixDispatcher dispatcher,
        string? cursor = null,
        int limit = CursorPaging.DefaultLimit)
    {
        if (limit is < 1 or > CursorPaging.MaximumLimit
            || !WorkspaceCursor.TryDecode(cursor, out var position))
        {
            return TypedResults.Problem(WorkspaceEndpoints.Problem(
                context, WorkspaceAdministrationErrors.InvalidCursor()));
        }
        var take = limit;
        var rows = await dispatcher.QueryAsync<ListWorkspaces, IReadOnlyList<WorkspaceSnapshot>>(
            new ListWorkspaces(position?.CreatedAt, position?.Id, take + 1), context.RequestAborted)
            .ConfigureAwait(false);
        var hasMore = rows.Count > take;
        var responses = new WorkspaceResponse[Math.Min(rows.Count, take)];
        for (var index = 0; index < responses.Length; index++)
        {
            responses[index] = WorkspaceEndpoints.ToResponse(rows[index]);
        }
        return TypedResults.Ok(new CursorPage<WorkspaceResponse>(
            responses, hasMore ? WorkspaceCursor.Encode(rows[take - 1]) : null));
    }
}

internal static class GetWorkspaceEndpoint
{
    internal static async Task<Results<Ok<WorkspaceResponse>, ProblemHttpResult>> Handle(
        Guid workspaceId, HttpContext context, [FromServices] NixDispatcher dispatcher)
    {
        var row = await dispatcher.QueryAsync<GetWorkspace, WorkspaceSnapshot?>(
            new GetWorkspace(WorkspaceId.From(workspaceId)), context.RequestAborted).ConfigureAwait(false);
        return row is null
            ? TypedResults.Problem(WorkspaceEndpoints.Problem(context, WorkspaceErrors.NotFound()))
            : TypedResults.Ok(WorkspaceEndpoints.ToResponse(row));
    }
}

internal static class CreateWorkspaceEndpoint
{
    internal static async Task<Results<Created<WorkspaceResponse>, ProblemHttpResult>> Handle(
        CreateWorkspaceRequest request, HttpContext context, [FromServices] NixDispatcher dispatcher)
    {
        var result = await dispatcher.SendAsync<CreateWorkspace, WorkspaceSnapshot>(
            new CreateWorkspace(request.Name), context.RequestAborted).ConfigureAwait(false);
        return result.Match<Results<Created<WorkspaceResponse>, ProblemHttpResult>>(
            row => TypedResults.Created($"/api/v1/workspaces/{row.Id}", WorkspaceEndpoints.ToResponse(row)),
            error => TypedResults.Problem(WorkspaceEndpoints.Problem(context, error)));
    }
}

internal static class RenameWorkspaceEndpoint
{
    internal static async Task<Results<Ok<WorkspaceResponse>, ProblemHttpResult>> Handle(
        Guid workspaceId, RenameWorkspaceRequest request, HttpContext context,
        [FromServices] NixDispatcher dispatcher)
    {
        var result = await dispatcher.SendAsync<RenameWorkspace, WorkspaceSnapshot>(
            new RenameWorkspace(WorkspaceId.From(workspaceId), request.Name), context.RequestAborted)
            .ConfigureAwait(false);
        return result.Match<Results<Ok<WorkspaceResponse>, ProblemHttpResult>>(
            row => TypedResults.Ok(WorkspaceEndpoints.ToResponse(row)),
            error => TypedResults.Problem(WorkspaceEndpoints.Problem(context, error)));
    }
}
