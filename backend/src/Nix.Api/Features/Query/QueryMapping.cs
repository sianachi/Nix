using System.Text.Json;
using System.Text.Json.Nodes;
using Nix.Domain.Query;

namespace Nix.Features.Query;

/// <summary>Maps a run's results onto the published shape.</summary>
internal static class QueryMapping
{
    /// <summary>Maps one run.</summary>
    /// <param name="itemId">The smart list that was run.</param>
    /// <param name="run">What it answered.</param>
    /// <returns>The published shape.</returns>
    internal static QueryResultsResponse ToResponse(Guid itemId, ItemQueryResults run)
    {
        ArgumentNullException.ThrowIfNull(run);

        var results = new List<QueryResultResponse>(run.Results.Items.Count);
        foreach (var item in run.Results.Items)
        {
            results.Add(new QueryResultResponse(
                item.Id.Value,
                item.WorkspaceId.Value,
                item.ContainerId?.Value,
                item.ContainerTitle,
                item.Title,
                item.Type,
                ReadProperties(item.PropertiesJson)));
        }

        return new QueryResultsResponse(
            itemId,
            run.ViewId,
            run.Today,
            results,
            run.Limit,
            run.Results.Truncated);
    }

    /// <summary>
    /// Reads a stored property bag, the same tolerance <c>ItemMapping</c> applies: a bag that will
    /// not parse costs the bag, never the row.
    /// </summary>
    private static JsonObject ReadProperties(string? properties)
    {
        if (string.IsNullOrWhiteSpace(properties))
        {
            return [];
        }

        try
        {
            return JsonNode.Parse(properties) as JsonObject ?? [];
        }
        catch (JsonException)
        {
            return [];
        }
    }
}
