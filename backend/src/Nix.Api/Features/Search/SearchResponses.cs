namespace Nix.Features.Search;

/// <summary>One item a search or a resolution found.</summary>
/// <param name="Id">The item.</param>
/// <param name="WorkspaceId">The workspace it lives in.</param>
/// <param name="Type">How its own body is drawn.</param>
/// <param name="Title">
/// What it is called, or <see langword="null"/> when it has never been named. The client decides
/// what to draw for an unnamed item; the server does not invent a name for it.
/// </param>
internal sealed record SearchHitResponse(Guid Id, Guid WorkspaceId, string Type, string? Title);

/// <summary>What a search returned.</summary>
/// <param name="Query">The query as it was interpreted, echoed so a client can discard a stale response.</param>
/// <param name="Results">The matches, most relevant first.</param>
/// <param name="Limit">The ceiling that was applied.</param>
/// <param name="Truncated">
/// Whether the ceiling was reached, so the interface can say "showing the first twenty" rather
/// than implying it has shown everything.
/// </param>
internal sealed record SearchResponse(
    string Query,
    IReadOnlyList<SearchHitResponse> Results,
    int Limit,
    bool Truncated);

/// <summary>
/// What one requested identifier resolved to.
/// </summary>
/// <param name="Id">The identifier that was asked about.</param>
/// <param name="Readable">Whether the caller may see it.</param>
/// <param name="Item">The item, when they may, and <see langword="null"/> when they may not.</param>
/// <remarks>
/// <b>Every requested identifier comes back, and only some of them come back with a title.</b> The
/// client needs to know the difference between "still loading" and "resolved, and not yours to
/// see", because a reference node carries a cached copy of the target's title and must render a
/// stub rather than that cache in the second case. Omitting unreadable identifiers entirely would
/// leave the two indistinguishable from the client's side.
///
/// <see cref="Readable"/> being false says nothing about why. It never existed, it was deleted, and
/// it belongs to a workspace this caller cannot reach are one answer here on purpose.
/// </remarks>
internal sealed record ReferenceResolutionResponse(Guid Id, bool Readable, SearchHitResponse? Item);

/// <summary>What a bulk resolution returned.</summary>
/// <param name="References">One entry per requested identifier, in the order they were asked for.</param>
internal sealed record ReferencesResponse(IReadOnlyList<ReferenceResolutionResponse> References);

/// <summary>One document that refers to the item being read.</summary>
/// <param name="Source">The referring item.</param>
/// <param name="Occurrences">How many times it refers to the target.</param>
internal sealed record BacklinkResponse(SearchHitResponse Source, int Occurrences);

/// <summary>What a backlinks read returned.</summary>
/// <param name="Backlinks">The referring documents, most-referring first.</param>
/// <param name="Limit">The ceiling that was applied.</param>
/// <param name="Truncated">Whether the ceiling was reached.</param>
internal sealed record BacklinksResponse(
    IReadOnlyList<BacklinkResponse> Backlinks,
    int Limit,
    bool Truncated);
