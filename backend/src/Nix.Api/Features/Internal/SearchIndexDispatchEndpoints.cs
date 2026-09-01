using System.Text.Json;
using System.Text.Json.Serialization;
using Microsoft.AspNetCore.Http.HttpResults;
using Microsoft.AspNetCore.Mvc;
using Nix.Persistence.Workers;

namespace Nix.Features.Internal;

/// <summary>Exact, service-authenticated hydration reads for the derived search index.</summary>
internal static class SearchIndexDispatchEndpoints
{
    internal static void Map(IEndpointRouteBuilder group)
    {
        group.MapGet("/worker-dispatch/index/items/{tenantId:guid}/{itemId:guid}", GetMetadata);
        group.MapGet("/worker-dispatch/index/items/{tenantId:guid}/{itemId:guid}/body", GetBody);
        group.MapPost("/worker-dispatch/index/rebuild", EnqueueRebuild);
        group.MapGet("/worker-dispatch/index/status", GetStatus);
    }

    private static async Task<Results<Ok<SearchIndexMetadataResponse>, NotFound>> GetMetadata(
        Guid tenantId,
        Guid itemId,
        [FromServices] SearchIndexDispatchStore store,
        CancellationToken cancellationToken)
    {
        var metadata = await store.GetMetadataAsync(tenantId, itemId, cancellationToken)
            .ConfigureAwait(false);
        return metadata is null
            ? TypedResults.NotFound()
            : TypedResults.Ok(SearchIndexMetadataResponse.From(metadata));
    }

    private static SearchIndexBodyResult GetBody(
        Guid tenantId,
        Guid itemId,
        [FromServices] SearchIndexDispatchStore store) =>
        new SearchIndexBodyResult(store, tenantId, itemId);

    private static async Task<Results<Ok<SearchIndexRebuildPageResponse>, BadRequest>> EnqueueRebuild(
        SearchIndexRebuildPageRequest request,
        [FromServices] SearchIndexDispatchStore store,
        CancellationToken cancellationToken)
    {
        if ((request.AfterTenantId is null) != (request.AfterItemId is null)
            || request.AfterTenantId == Guid.Empty
            || request.AfterItemId == Guid.Empty
            || request.UpdatedSince == DateTimeOffset.MinValue
            || request.Limit is < 1 or > 1000)
        {
            return TypedResults.BadRequest();
        }

        var page = await store.EnqueueRebuildPageAsync(
            request.AfterTenantId,
            request.AfterItemId,
            request.UpdatedSince,
            request.Limit,
            cancellationToken).ConfigureAwait(false);
        return TypedResults.Ok(new SearchIndexRebuildPageResponse(
            page.Enqueued,
            page.NextTenantId,
            page.NextItemId,
            page.HasMore));
    }

    private static async Task<Ok<SearchIndexOutboxStatusResponse>> GetStatus(
        [FromServices] SearchIndexDispatchStore store,
        CancellationToken cancellationToken)
    {
        var status = await store.GetOutboxStatusAsync(cancellationToken).ConfigureAwait(false);
        return TypedResults.Ok(new SearchIndexOutboxStatusResponse(
            status.Pending,
            status.OldestAvailableAt,
            status.HighestAttempts,
            status.PendingFailures));
    }
}

/// <summary>A restartable cursor for a full or incremental index rebuild.</summary>
public sealed record SearchIndexRebuildPageRequest(
    Guid? AfterTenantId = null,
    Guid? AfterItemId = null,
    DateTimeOffset? UpdatedSince = null,
    int Limit = 500);

/// <summary>The durable work emitted by one rebuild page.</summary>
public sealed record SearchIndexRebuildPageResponse(
    int Enqueued,
    Guid? NextTenantId,
    Guid? NextItemId,
    bool HasMore);

/// <summary>Current Postgres outbox lag before RabbitMQ publication.</summary>
public sealed record SearchIndexOutboxStatusResponse(
    long Pending,
    DateTimeOffset? OldestAvailableAt,
    int HighestAttempts,
    long PendingFailures);

/// <summary>The current metadata half of one derived search document.</summary>
public sealed record SearchIndexMetadataResponse(
    [property: JsonPropertyName("tenant_id")] Guid TenantId,
    [property: JsonPropertyName("workspace_id")] Guid WorkspaceId,
    [property: JsonPropertyName("item_id")] Guid ItemId,
    [property: JsonPropertyName("parent_id")] Guid? ParentId,
    [property: JsonPropertyName("item_type")] string ItemType,
    [property: JsonPropertyName("title")] string? Title,
    [property: JsonPropertyName("property_text")] string PropertyText,
    [property: JsonPropertyName("properties")] JsonElement Properties,
    [property: JsonPropertyName("ancestor_ids")] IReadOnlyList<Guid> AncestorIds,
    [property: JsonPropertyName("links")] IReadOnlyList<Guid> Links,
    [property: JsonPropertyName("authorization_keys")] IReadOnlyList<string> AuthorizationKeys,
    [property: JsonPropertyName("lifecycle_state")] string LifecycleState,
    [property: JsonPropertyName("indexable")] bool Indexable,
    [property: JsonPropertyName("source_updated_at")] DateTimeOffset SourceUpdatedAt)
{
    internal static SearchIndexMetadataResponse From(SearchIndexMetadataRecord value) => new(
        value.TenantId,
        value.WorkspaceId,
        value.ItemId,
        value.ParentId,
        value.ItemType,
        value.Title,
        value.PropertyText,
        value.Properties,
        value.AncestorIds,
        value.Links,
        value.AuthorizationKeys,
        value.LifecycleState,
        value.Indexable,
        value.SourceUpdatedAt);
}

internal sealed class SearchIndexBodyResult(
    SearchIndexDispatchStore store,
    Guid tenantId,
    Guid itemId) : IResult
{
    public async Task ExecuteAsync(HttpContext httpContext)
    {
        ArgumentNullException.ThrowIfNull(httpContext);
        var body = await store.OpenBodyAsync(
            tenantId,
            itemId,
            httpContext.RequestAborted).ConfigureAwait(false);
        if (body is null)
        {
            httpContext.Response.StatusCode = StatusCodes.Status404NotFound;
            return;
        }

        await using (body.ConfigureAwait(false))
        {
            if (!body.HasBody)
            {
                httpContext.Response.StatusCode = StatusCodes.Status204NoContent;
                return;
            }

            httpContext.Response.StatusCode = StatusCodes.Status200OK;
            httpContext.Response.ContentType = "text/plain; charset=utf-8";
            httpContext.Response.Headers.XContentTypeOptions = "nosniff";
            await body.CopyToAsync(httpContext.Response.Body, httpContext.RequestAborted)
                .ConfigureAwait(false);
        }
    }
}
