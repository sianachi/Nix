using Microsoft.AspNetCore.Http.HttpResults;
using Microsoft.AspNetCore.Mvc;
using Nix.Api.Errors;
using Nix.Api.Features.Items;
using Nix.Api.Features.Views;
using Nix.Application.Properties;
using Nix.Core.Items;
using Nix.Core.Primitives;

namespace Nix.Api.Features.Properties;

/// <summary>
/// Route registration for what gives an item structure: its schema, its property values, and the
/// views its container offers.
/// </summary>
/// <remarks>
/// <para>
/// One feature group rather than three, because the three are one idea: a schema declares what a
/// property means, a property value is an instance of it, and a view is a way of arranging items
/// by those values. Splitting them would put three route files in front of one concept.
/// </para>
/// <para>
/// Every failure code here is namespaced by feature so two features can never collide, and the
/// frontend switches on the literal rather than on message text.
/// </para>
/// </remarks>
internal static class StructureEndpoints
{
    /// <summary>Registers the structure routes.</summary>
    /// <param name="endpoints">The route builder.</param>
    /// <returns>The route builder, for chaining.</returns>
    internal static IEndpointRouteBuilder MapStructureEndpoints(this IEndpointRouteBuilder endpoints)
    {
        ArgumentNullException.ThrowIfNull(endpoints);

        var items = endpoints.MapGroup("/api/v1/items").WithTags("Structure");

        items.MapGet("/{itemId:guid}/schema", GetSchema)
            .WithName("GetEffectiveSchema")
            .WithSummary("The property schema in force at an item")
            .WithDescription(
                "Returns the merged result of every ancestor's declaration, nearest winning, "
                + "alongside the subset this item declares itself. Both are needed: an editor "
                + "shown only the merged result would save inherited properties back onto the "
                + "item and silently turn inheritance into a copy.")
            .Produces<EffectiveSchemaResponse>(StatusCodes.Status200OK)
            .ProducesProblem(StatusCodes.Status404NotFound);

        items.MapPut("/{itemId:guid}/schema", SetSchema)
            .WithName("SetItemSchema")
            .WithSummary("Declare the property schema for an item's subtree")
            .WithDescription(
                "Replaces what this item declares. Ancestors are unaffected, and so are the "
                + "property values already stored beneath it: a property removed from a schema "
                + "stops being validated and stops being displayed, and returns intact if the "
                + "schema does. Fails with 'schema.invalid' when the document cannot be stored.")
            .Produces<EffectiveSchemaResponse>(StatusCodes.Status200OK)
            .ProducesProblem(StatusCodes.Status404NotFound)
            .ProducesProblem(StatusCodes.Status409Conflict)
            .ProducesProblem(StatusCodes.Status422UnprocessableEntity);

        items.MapPatch("/{itemId:guid}/properties", SetProperties)
            .WithName("SetItemProperties")
            .WithSummary("Write property values onto an item")
            .WithDescription(
                "Merges the supplied properties into the item's bag: a member set to null clears "
                + "that property, and anything not mentioned is left alone. This is what a board "
                + "drag and a calendar drag both perform - the change is to the item, so it is "
                + "visible in every view. Fails with 'properties.invalid' when a value does not "
                + "fit the schema in force.")
            .Produces<ItemResponse>(StatusCodes.Status200OK)
            .ProducesProblem(StatusCodes.Status404NotFound)
            .ProducesProblem(StatusCodes.Status409Conflict)
            .ProducesProblem(StatusCodes.Status422UnprocessableEntity);

        items.MapGet("/{itemId:guid}/views", GetViews)
            .WithName("GetContainerViews")
            .WithSummary("The views a container offers")
            .WithDescription(
                "Returns the views in switcher order, plus the identifiers of any whose "
                + "configured property no longer exists or no longer fits. A board grouping by a "
                + "deleted property would otherwise render as an empty board, which is "
                + "indistinguishable from an item with nothing in it.")
            .Produces<ContainerViewsResponse>(StatusCodes.Status200OK)
            .ProducesProblem(StatusCodes.Status404NotFound);

        items.MapPut("/{itemId:guid}/views", SetViews)
            .WithName("SetContainerViews")
            .WithSummary("Replace the views a container offers")
            .WithDescription(
                "A whole-set replacement, because the order is part of what is being edited. "
                + "Fails with 'views.invalid' when a view is not storable.")
            .Produces<ContainerViewsResponse>(StatusCodes.Status200OK)
            .ProducesProblem(StatusCodes.Status404NotFound)
            .ProducesProblem(StatusCodes.Status409Conflict)
            .ProducesProblem(StatusCodes.Status422UnprocessableEntity);

        return endpoints;
    }

    private static async Task<Results<Ok<EffectiveSchemaResponse>, ProblemHttpResult>> GetSchema(
        Guid itemId,
        HttpContext httpContext,
        [FromServices] GetEffectiveSchema getEffectiveSchema)
    {
        var result = await getEffectiveSchema
            .ExecuteAsync(ItemId.From(itemId), httpContext.RequestAborted)
            .ConfigureAwait(false);

        return result.Match<Results<Ok<EffectiveSchemaResponse>, ProblemHttpResult>>(
            schema => TypedResults.Ok(PropertyMapping.ToResponse(schema.Effective, schema.Declared)),
            error => TypedResults.Problem(Problem(httpContext, error)));
    }

    private static async Task<Results<Ok<EffectiveSchemaResponse>, ProblemHttpResult>> SetSchema(
        Guid itemId,
        SetSchemaRequest request,
        HttpContext httpContext,
        [FromServices] SetItemSchema setItemSchema,
        [FromServices] GetEffectiveSchema getEffectiveSchema)
    {
        if (!PropertyMapping.TryToDomain(request, out var schema, out var unknownType))
        {
            // Refused rather than dropped. The stored-schema reader drops what it cannot interpret
            // so a bad schema never makes items unreadable; a request somebody is waiting on an
            // answer to is the opposite case.
            return TypedResults.Problem(
                Problem(
                    httpContext,
                    PropertyErrors.InvalidSchema($"'{unknownType}' is not a property type.")));
        }

        var stored = await setItemSchema
            .ExecuteAsync(ItemId.From(itemId), schema, httpContext.RequestAborted)
            .ConfigureAwait(false);

        if (stored.IsFailure)
        {
            return TypedResults.Problem(Problem(httpContext, stored.Error));
        }

        // Re-resolved rather than echoing what was sent: what the caller now needs is the merged
        // result, and only the resolver knows what the ancestors contribute.
        var effective = await getEffectiveSchema
            .ExecuteAsync(ItemId.From(itemId), httpContext.RequestAborted)
            .ConfigureAwait(false);

        return effective.Match<Results<Ok<EffectiveSchemaResponse>, ProblemHttpResult>>(
            resolved => TypedResults.Ok(PropertyMapping.ToResponse(resolved.Effective, resolved.Declared)),
            error => TypedResults.Problem(Problem(httpContext, error)));
    }

    private static async Task<Results<Ok<ItemResponse>, ProblemHttpResult>> SetProperties(
        Guid itemId,
        SetPropertiesRequest request,
        HttpContext httpContext,
        [FromServices] SetItemProperties setItemProperties,
        [FromServices] Nix.Application.Items.ItemsWithChildren itemsWithChildren)
    {
        var result = await setItemProperties
            .ExecuteAsync(ItemId.From(itemId), request.Properties.ToJsonString(), httpContext.RequestAborted)
            .ConfigureAwait(false);

        if (result.IsFailure)
        {
            return TypedResults.Problem(Problem(httpContext, result.Error));
        }

        var item = result.Value;
        var withChildren = await itemsWithChildren
            .ExecuteAsync(item.WorkspaceId, [item.Id], httpContext.RequestAborted)
            .ConfigureAwait(false);

        return TypedResults.Ok(ItemMapping.ToResponse(item, withChildren.Contains(item.Id)));
    }

    private static async Task<Results<Ok<ContainerViewsResponse>, ProblemHttpResult>> GetViews(
        Guid itemId,
        HttpContext httpContext,
        [FromServices] Application.Views.GetContainerViews getContainerViews)
    {
        var result = await getContainerViews
            .ExecuteAsync(ItemId.From(itemId), httpContext.RequestAborted)
            .ConfigureAwait(false);

        return result.Match<Results<Ok<ContainerViewsResponse>, ProblemHttpResult>>(
            views => TypedResults.Ok(
                new ContainerViewsResponse(
                    [.. views.Views.Select(ViewMapping.ToResponse)],
                    views.Unrenderable,
                    views.Default)),
            error => TypedResults.Problem(Problem(httpContext, error)));
    }

    private static async Task<Results<Ok<ContainerViewsResponse>, ProblemHttpResult>> SetViews(
        Guid itemId,
        SetViewsRequest request,
        HttpContext httpContext,
        [FromServices] Application.Views.SetContainerViews setContainerViews,
        [FromServices] Application.Views.GetContainerViews getContainerViews)
    {
        if (!ViewMapping.TryToDomain(request, out var views, out var unknownKind))
        {
            return TypedResults.Problem(
                Problem(
                    httpContext,
                    PropertyErrors.InvalidViews($"'{unknownKind}' is not a view kind.")));
        }

        var stored = await setContainerViews
            .ExecuteAsync(ItemId.From(itemId), views, request.Default, httpContext.RequestAborted)
            .ConfigureAwait(false);

        if (stored.IsFailure)
        {
            return TypedResults.Problem(Problem(httpContext, stored.Error));
        }

        // Read back so the response carries the unrenderable list, which the write path does not
        // compute and the caller needs in order to say anything honest about what it just saved.
        var reread = await getContainerViews
            .ExecuteAsync(ItemId.From(itemId), httpContext.RequestAborted)
            .ConfigureAwait(false);

        return reread.Match<Results<Ok<ContainerViewsResponse>, ProblemHttpResult>>(
            set => TypedResults.Ok(
                new ContainerViewsResponse(
                    [.. set.Views.Select(ViewMapping.ToResponse)],
                    set.Unrenderable,
                    set.Default)),
            error => TypedResults.Problem(Problem(httpContext, error)));
    }

    /// <summary>
    /// Maps a use case's failure onto the status its stable code implies.
    /// </summary>
    /// <remarks>
    /// The code is the contract; the status is a consequence of it. A malformed schema or an
    /// invalid property value is 422 rather than 400: the request was understood and well-formed,
    /// and what it asked for is what could not be done.
    /// </remarks>
    private static Microsoft.AspNetCore.Mvc.ProblemDetails Problem(HttpContext httpContext, NixError error)
    {
        var status = error.Code switch
        {
            PropertyErrors.InvalidPropertiesCode
                or PropertyErrors.InvalidSchemaCode
                or PropertyErrors.InvalidViewsCode => StatusCodes.Status422UnprocessableEntity,
            ItemEndpoints.LifecycleConflictCode => StatusCodes.Status409Conflict,
            _ => StatusCodes.Status404NotFound,
        };

        return ApiProblem.Create(httpContext, status, error.Code, "Request refused", error.Message);
    }
}
