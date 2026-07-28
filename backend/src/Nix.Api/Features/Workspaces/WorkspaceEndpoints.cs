using Microsoft.AspNetCore.Http.HttpResults;
using Nix.Contracts;
using Nix.Errors;

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

        workspaces.MapGet("/", ListWorkspaces)
            .WithName("ListWorkspaces")
            .WithSummary("Workspaces the caller can see")
            .WithDescription(
                "Returns the workspaces the calling principal is a member of, newest first. "
                + "Workspaces the caller cannot see are omitted entirely rather than redacted: a "
                + "list is how you enumerate what exists, so a placeholder would leak the fact of "
                + "them.")
            .Produces<CursorPage<WorkspaceResponse>>(StatusCodes.Status200OK)
            .ProducesProblem(StatusCodes.Status501NotImplemented);

        workspaces.MapGet("/{workspaceId:guid}", GetWorkspace)
            .WithName("GetWorkspace")
            .WithSummary("One workspace")
            .WithDescription(
                "Returns the workspace, or a problem with code 'workspaces.not_found'. A workspace "
                + "the caller may not see is reported as not found rather than as forbidden, so "
                + "the response cannot be used to confirm that it exists.")
            .Produces<WorkspaceResponse>(StatusCodes.Status200OK)
            .ProducesProblem(StatusCodes.Status404NotFound)
            .ProducesProblem(StatusCodes.Status501NotImplemented);

        return endpoints;
    }

    private static Results<Ok<CursorPage<WorkspaceResponse>>, ProblemHttpResult> ListWorkspaces(
        HttpContext httpContext,
        string? cursor = null,
        int limit = CursorPaging.DefaultLimit) =>
        ContractStub.NotImplemented(httpContext, "ListWorkspaces");

    private static Results<Ok<WorkspaceResponse>, ProblemHttpResult> GetWorkspace(
        Guid workspaceId,
        HttpContext httpContext) =>
        ContractStub.NotImplemented(httpContext, "GetWorkspace");
}
