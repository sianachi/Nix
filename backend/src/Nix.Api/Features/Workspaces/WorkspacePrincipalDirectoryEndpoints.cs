using System.Text;
using Microsoft.AspNetCore.Http.HttpResults;
using Microsoft.AspNetCore.Mvc;
using Nix.Contracts;
using Nix.Domain.Identity;
using Nix.Domain.Primitives;
using Nix.Domain.Tenancy;
using Nix.Messaging;
using Nix.Persistence.Workspaces;

namespace Nix.Features.Workspaces;

internal sealed record WorkspacePrincipalResponse(Guid PrincipalId, string DisplayName, string Kind);

internal static class WorkspacePrincipalDirectoryEndpoints
{
    private const int MaximumPageSize = 100;
    private const int MaximumSearchLength = 128;
    private const int MaximumCursorLength = 512;

    internal static void Map(IEndpointRouteBuilder workspaces)
    {
        workspaces.MapGet("/{workspaceId:guid}/principals", List)
            .WithName("ListWorkspaceAssignablePrincipals")
            .WithSummary("Active principals who can be assigned in a workspace")
            .Produces<CursorPage<WorkspacePrincipalResponse>>(StatusCodes.Status200OK)
            .ProducesProblem(StatusCodes.Status422UnprocessableEntity);
    }

    internal static async Task<Results<Ok<CursorPage<WorkspacePrincipalResponse>>, ProblemHttpResult>> List(
        Guid workspaceId,
        HttpContext context,
        [FromServices] NixDispatcher dispatcher,
        string? query = null,
        string? cursor = null,
        int limit = MaximumPageSize)
    {
        var search = query?.Trim();
        if (limit is < 1 or > MaximumPageSize
            || search?.Length > MaximumSearchLength
            || !TryCursor(cursor, out var afterPrincipalId))
        {
            return TypedResults.Problem(WorkspaceEndpoints.Problem(
                context,
                new NixError("workspaces.principal_search_invalid", "The principal search parameters are invalid.")));
        }

        var take = limit;
        var rows = await dispatcher.QueryAsync<
            ListWorkspaceAssignablePrincipals,
            IReadOnlyList<WorkspacePrincipalSnapshot>>(
                new ListWorkspaceAssignablePrincipals(
                    WorkspaceId.From(workspaceId),
                    string.IsNullOrEmpty(search) ? null : search,
                    afterPrincipalId,
                    take + 1),
                context.RequestAborted)
            .ConfigureAwait(false);
        var responses = rows.Take(take)
            .Select(row => new WorkspacePrincipalResponse(row.PrincipalId.Value, row.DisplayName, row.Kind))
            .ToArray();
        var next = rows.Count > take && responses.Length > 0
            ? EncodeCursor(rows[take - 1].PrincipalId)
            : null;
        return TypedResults.Ok(new CursorPage<WorkspacePrincipalResponse>(responses, next));
    }

    private static bool TryCursor(string? value, out PrincipalId? id)
    {
        id = null;
        if (string.IsNullOrWhiteSpace(value))
        {
            return true;
        }
        if (value.Length > MaximumCursorLength)
        {
            return false;
        }
        try
        {
            var text = Encoding.UTF8.GetString(Convert.FromBase64String(value));
            if (!Guid.TryParseExact(text, "D", out var parsed))
            {
                return false;
            }
            id = PrincipalId.From(parsed);
            return true;
        }
        catch (FormatException)
        {
            return false;
        }
    }

    private static string EncodeCursor(PrincipalId id) => Convert.ToBase64String(
        Encoding.UTF8.GetBytes(id.Value.ToString("D")));
}
