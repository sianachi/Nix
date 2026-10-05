using System.Text.Json.Nodes;

namespace Nix.Features.Query;

/// <summary>One item a saved query matched.</summary>
/// <param name="Id">The item.</param>
/// <param name="WorkspaceId">The workspace it lives in.</param>
/// <param name="ContainerId">Its parent, or <see langword="null"/> at a workspace root.</param>
/// <param name="ContainerTitle">
/// The parent's title, or <see langword="null"/>. Carried so a cross-container row can say where
/// it lives without the client fetching the tree to render one line - the calendar's own shape.
/// The full ancestry is deliberately not carried; a breadcrumb is a closure join a later goal can
/// pay for if a title proves too little.
/// </param>
/// <param name="Title">The item's title, or <see langword="null"/> when it has never been named.</param>
/// <param name="Type">The item's body kind.</param>
/// <param name="Properties">The property bag as stored, so the row can show the values it matched on.</param>
internal sealed record QueryResultResponse(
    Guid Id,
    Guid WorkspaceId,
    Guid? ContainerId,
    string? ContainerTitle,
    string? Title,
    string Type,
    JsonObject Properties);

/// <summary>What one run of a saved query answered.</summary>
/// <param name="ItemId">The smart list that was run.</param>
/// <param name="ViewId">The query view that ran.</param>
/// <param name="Today">The day the <c>today</c> token resolved to, echoed back.</param>
/// <param name="Results">The matches, in the run's stable order.</param>
/// <param name="Limit">The ceiling the run applied.</param>
/// <param name="Truncated">
/// Whether more rows matched than <paramref name="Limit"/> allowed. The honest-state field: a
/// list that was cut and does not say so reads as a list that ended.
/// </param>
internal sealed record QueryResultsResponse(
    Guid ItemId,
    string ViewId,
    string Today,
    IReadOnlyList<QueryResultResponse> Results,
    int Limit,
    bool Truncated);
