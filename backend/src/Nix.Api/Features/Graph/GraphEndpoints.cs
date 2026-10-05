using System.Globalization;
using Microsoft.AspNetCore.Mvc;
using Nix.Domain.Primitives;
using Nix.Errors;

namespace Nix.Features.Graph;

/// <summary>
/// Route registration for the graph feature: one workspace, drawn.
/// </summary>
/// <remarks>
/// Its own feature rather than a route on the search feature, even though both stand on
/// <c>item_link</c>. Search answers "which items match this", starting from something the caller
/// typed; the graph answers "what is in here and how is it joined up", starting from nothing but a
/// workspace. The second is a bulk disclosure surface and deserves to be read as one.
/// </remarks>
internal static class GraphEndpoints
{
    /// <summary>Stable code for "no such workspace, or the caller cannot see it".</summary>
    /// <remarks>
    /// The same literal the workspaces feature publishes. Spelled out rather than referenced so
    /// this feature owns its own contract, and asserted equal to the workspaces feature's code by
    /// test, which is the check a shared reference would only have looked like.
    /// </remarks>
    internal const string WorkspaceNotFoundCode = "workspaces.not_found";

    /// <summary>
    /// Registers the graph feature's routes on <paramref name="endpoints"/>.
    /// </summary>
    internal static IEndpointRouteBuilder MapGraphEndpoints(this IEndpointRouteBuilder endpoints)
    {
        ArgumentNullException.ThrowIfNull(endpoints);

        var workspaces = endpoints.MapGroup("/api/v1/workspaces").WithTags("Graph");

        workspaces.MapGet("/{workspaceId:guid}/graph", GetWorkspaceGraphEndpoint.Handle)
            .WithName("GetWorkspaceGraph")
            .WithSummary("A workspace as nodes and reference edges")
            .WithDescription(
                "Returns everything needed to draw one workspace as a graph: a node per item, "
                + "carrying its identifier, parent, body kind and title, and a link per reference "
                + "edge between two of those nodes. "
                + "Only items the caller may read are included, and they are excluded while the "
                + "query runs rather than filtered out of its results - an item that is not visible "
                + "is absent from the nodes, absent from every link, and absent from the counts. "
                + "A link is returned only when both of its ends are nodes in the same response, "
                + "so nothing points outside the payload; a node's parentId is likewise null when "
                + "the parent is not itself in it. "
                + "The response is bounded at "
                + NodeCeiling
                + " nodes and "
                + LinkCeiling
                + " links, applied in that order. When a ceiling is reached the matching "
                + "'nodesTruncated' or 'linksTruncated' flag is true and the graph shown is a real "
                + "part of the workspace rather than all of it - which a drawing cannot convey on "
                + "its own, so a client must say so. Nodes enter in the workspace's own sibling "
                + "order, so a truncated read keeps the top of the tree. "
                + "A workspace the caller may not see is reported as not found rather than as "
                + "forbidden, so the response cannot be used to confirm that it exists.")
            .Produces<WorkspaceGraphResponse>(StatusCodes.Status200OK)
            .ProducesProblem(StatusCodes.Status404NotFound);

        return endpoints;
    }

    /// <summary>
    /// Maps a use case's failure onto the status its stable code implies.
    /// </summary>
    /// <param name="httpContext">The current request.</param>
    /// <param name="error">Why the use case failed.</param>
    /// <returns>Problem details describing the failure.</returns>
    /// <remarks>
    /// Total over the codes this feature can raise, and 500 for anything else. A default of 404
    /// would be the worst possible one: a code added to <see cref="GraphErrors"/> and forgotten
    /// here would reach clients as the one status they already handle, carrying a message about
    /// something else entirely.
    /// </remarks>
    internal static ProblemDetails Problem(HttpContext httpContext, NixError error)
    {
        var status = error.Code switch
        {
            WorkspaceNotFoundCode => StatusCodes.Status404NotFound,
            _ => StatusCodes.Status500InternalServerError,
        };

        return ApiProblem.Create(httpContext, status, error.Code, "Request refused", error.Message);
    }

    /// <summary>The node ceiling as the published description spells it.</summary>
    /// <remarks>
    /// Read off the handler rather than typed, so raising the ceiling cannot leave the contract
    /// describing the old one. The same reason <c>ViewKindProse</c> generates its sentences.
    /// </remarks>
    private static string NodeCeiling =>
        GetWorkspaceGraphHandler.MaximumNodes.ToString("N0", CultureInfo.InvariantCulture);

    /// <summary>The link ceiling as the published description spells it.</summary>
    private static string LinkCeiling =>
        GetWorkspaceGraphHandler.MaximumLinks.ToString("N0", CultureInfo.InvariantCulture);
}
