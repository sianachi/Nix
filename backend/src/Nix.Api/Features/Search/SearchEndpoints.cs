using Microsoft.AspNetCore.Mvc;
using Nix.Domain.Primitives;
using Nix.Errors;

namespace Nix.Features.Search;

/// <summary>
/// Route registration for the search feature: finding items, resolving what a document points at,
/// and reading what points back.
/// </summary>
/// <remarks>
/// <para>
/// One feature rather than three, because all three answer the same question with a different
/// starting point - "which items may this caller see, given X" - and all three stand on the same
/// pair of derived tables. Splitting them would mean the permission predicate written three times.
/// </para>
/// <para>
/// Searching has no route of its own under an item or a workspace: it opens over whatever is on
/// screen and is scoped by what the caller may read, not by where they happen to be.
/// </para>
/// </remarks>
internal static class SearchEndpoints
{
    /// <summary>Stable code for "no such item, or the caller cannot see it".</summary>
    internal const string NotFoundCode = "items.not_found";

    /// <summary>Stable code for a resolution request naming too many identifiers.</summary>
    internal const string TooManyReferencesCode = "search.too_many_references";

    /// <summary>Stable code for a resolution request whose identifier list will not parse.</summary>
    internal const string MalformedReferencesCode = "search.malformed_references";

    /// <summary>
    /// Registers the search feature's routes on <paramref name="endpoints"/>.
    /// </summary>
    internal static IEndpointRouteBuilder MapSearchEndpoints(this IEndpointRouteBuilder endpoints)
    {
        ArgumentNullException.ThrowIfNull(endpoints);

        var search = endpoints.MapGroup("/api/v1/search").WithTags("Search");

        search.MapGet("/", SearchItemsEndpoint.Handle)
            .WithName("SearchItems")
            .WithSummary("Find items by title or document text")
            .WithDescription(
                "Returns items whose title contains 'q', or whose document text matches it, with "
                + "title matches ranked first. The search covers every workspace the caller may "
                + "read and nothing else - the filter is a predicate inside the query, so the "
                + "limit is never spent on rows that would then be discarded. An item in a "
                + "workspace the caller cannot reach is omitted entirely rather than redacted. A "
                + "blank query returns no results rather than every item.")
            .Produces<SearchResponse>(StatusCodes.Status200OK);

        search.MapGet("/references", ResolveReferencesEndpoint.Handle)
            .WithName("ResolveReferences")
            .WithSummary("Resolve the items a document's references point at")
            .WithDescription(
                "Takes 'ids' as a comma-separated list of identifiers and returns one entry for "
                + "each, in the order asked. An entry the caller may read carries the item's "
                + "current title; one they may not carries 'readable: false' and no title at all. "
                + "The two are distinguishable on purpose, because a reference node caches the "
                + "target's title for rendering and must show a stub rather than that cache when "
                + "the reader has no permission on it. Why an identifier did not resolve is "
                + "deliberately not reported: deleted, never existed, and not visible to you are "
                + "one answer.")
            .Produces<ReferencesResponse>(StatusCodes.Status200OK)
            .ProducesProblem(StatusCodes.Status400BadRequest);

        var items = endpoints.MapGroup("/api/v1/items").WithTags("Search");

        items.MapGet("/{itemId:guid}/backlinks", GetBacklinksEndpoint.Handle)
            .WithName("GetBacklinks")
            .WithSummary("The documents that refer to an item")
            .WithDescription(
                "Returns the items whose documents link to this one, most-referring first. Only "
                + "referring documents the caller may read are included, and they are excluded "
                + "from the count as well as from the list: being able to read an item does not "
                + "entitle you to know that a document elsewhere mentions it. Backlinks are "
                + "derived from documents when they are snapshotted, so a link made moments ago "
                + "may not have been published yet.")
            .Produces<BacklinksResponse>(StatusCodes.Status200OK)
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
    /// The code is the contract; the status is a consequence of it. Deciding the status here, in
    /// one place, is what stops two endpoints answering the same failure differently.
    /// </remarks>
    internal static ProblemDetails Problem(HttpContext httpContext, NixError error)
    {
        // Total over the codes this feature can raise, and 500 for anything else. A default of 404
        // would be the worst possible one: a code added to SearchErrors and forgotten here would
        // reach clients as the one status they already handle, carrying a message about something
        // else entirely.
        var status = error.Code switch
        {
            NotFoundCode => StatusCodes.Status404NotFound,
            TooManyReferencesCode or MalformedReferencesCode => StatusCodes.Status400BadRequest,
            _ => StatusCodes.Status500InternalServerError,
        };

        return ApiProblem.Create(httpContext, status, error.Code, "Request refused", error.Message);
    }
}
