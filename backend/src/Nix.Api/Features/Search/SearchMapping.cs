using Nix.Domain.Items;

namespace Nix.Features.Search;

/// <summary>
/// Turns the domain's item projections into the shapes this feature publishes.
/// </summary>
/// <remarks>
/// One place, because three endpoints return the same four fields and a fourth will. The mapping
/// is deliberately dull: no defaulting, no formatting, no "Untitled" invented for an item that has
/// never been named. A name a person did not choose is copy, and copy belongs where it can be
/// translated.
/// </remarks>
internal static class SearchMapping
{
    /// <summary>Maps one item projection.</summary>
    /// <param name="digest">The projection.</param>
    /// <returns>The published shape.</returns>
    internal static SearchHitResponse ToResponse(ItemDigest digest)
    {
        ArgumentNullException.ThrowIfNull(digest);

        return new SearchHitResponse(
            digest.Id.Value,
            digest.WorkspaceId.Value,
            digest.Type,
            digest.Title);
    }

    /// <summary>Maps a list of item projections, preserving order.</summary>
    /// <param name="digests">The projections.</param>
    /// <returns>The published shapes.</returns>
    internal static IReadOnlyList<SearchHitResponse> ToResponses(IReadOnlyList<ItemDigest> digests)
    {
        ArgumentNullException.ThrowIfNull(digests);

        var responses = new List<SearchHitResponse>(digests.Count);
        foreach (var digest in digests)
        {
            responses.Add(ToResponse(digest));
        }

        return responses;
    }
}
