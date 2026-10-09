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

    /// <summary>Maps one ad-hoc run.</summary>
    /// <param name="workspaceId">The workspace that was queried.</param>
    /// <param name="run">What it answered.</param>
    /// <returns>The published shape.</returns>
    internal static WorkspaceQueryResponse ToResponse(Guid workspaceId, WorkspaceQueryResults run)
    {
        ArgumentNullException.ThrowIfNull(run);

        var results = new List<WorkspaceQueryRowResponse>(run.Results.Items.Count);
        foreach (var item in run.Results.Items)
        {
            results.Add(new WorkspaceQueryRowResponse(
                item.Id.Value,
                item.WorkspaceId.Value,
                item.ContainerId?.Value,
                item.ContainerTitle,
                item.Title,
                item.Type,
                ReadProperties(item.PropertiesJson),
                item.Group));
        }

        var groups = new List<QueryGroupResponse>(run.Results.Groups.Count);
        foreach (var group in run.Results.Groups)
        {
            groups.Add(new QueryGroupResponse(group.Key, group.Key, group.Count));
        }

        return new WorkspaceQueryResponse(
            workspaceId,
            run.Today,
            results,
            run.Limit,
            run.Results.Truncated,
            run.GroupBy,
            groups);
    }

    /// <summary>Maps one ad-hoc aggregate.</summary>
    /// <param name="workspaceId">The workspace that was queried.</param>
    /// <param name="run">What it answered.</param>
    /// <returns>The published shape.</returns>
    internal static WorkspaceAggregateResponse ToResponse(Guid workspaceId, WorkspaceAggregateResults run)
    {
        ArgumentNullException.ThrowIfNull(run);

        var groups = new List<AggregateGroupResponse>(run.Results.Groups.Count);
        foreach (var group in run.Results.Groups)
        {
            groups.Add(new AggregateGroupResponse(group.Key, group.Key, group.Value, group.Count, group.Skipped));
        }

        return new WorkspaceAggregateResponse(
            workspaceId,
            run.Today,
            run.Function,
            run.Property,
            run.GroupBy,
            groups,
            run.Results.Total,
            run.Results.Count,
            run.Results.Skipped,
            run.Results.GroupCount,
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
