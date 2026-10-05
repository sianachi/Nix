namespace Nix.Features.Search;

/// <summary>One item a search or a resolution found.</summary>
/// <param name="Id">The item.</param>
/// <param name="WorkspaceId">The workspace it lives in.</param>
/// <param name="Type">How its own body is drawn.</param>
/// <param name="Title">
/// What it is called, or <see langword="null"/> when it has never been named. The client decides
/// what to draw for an unnamed item; the server does not invent a name for it.
/// </param>
/// <param name="ParentId">
/// The item it sits under, or <see langword="null"/> for a workspace root - the same value the item
/// read returns, so a picker can rank siblings of the note being edited first.
/// </param>
/// <param name="UpdatedAt">When the item was last modified, for ranking by recency.</param>
internal sealed record SearchHitResponse(
    Guid Id,
    Guid WorkspaceId,
    string Type,
    string? Title,
    Guid? ParentId,
    DateTimeOffset UpdatedAt);

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

/// <summary>One item the documents linking to the item being read also link to.</summary>
/// <param name="Item">The co-cited item.</param>
/// <param name="SharedSources">
/// How many readable, unlocked documents link to both. Documents the caller may not read are left
/// out of the count, not just out of a list.
/// </param>
internal sealed record RelatedItemResponse(SearchHitResponse Item, int SharedSources);

/// <summary>What a related-items read returned.</summary>
/// <param name="Related">The co-cited items, most shared sources first.</param>
/// <param name="Limit">The ceiling that was applied.</param>
/// <param name="Truncated">
/// Whether the ceiling was reached. The ranking itself always considers at most the target's
/// <see cref="GetRelatedItemsHandler.MaximumSources"/> most-referring readable documents.
/// </param>
internal sealed record RelatedItemsResponse(
    IReadOnlyList<RelatedItemResponse> Related,
    int Limit,
    bool Truncated);

/// <summary>The passage to look for mentions in, and where.</summary>
/// <param name="Text">
/// The text, at most <see cref="FindMentionsHandler.MaximumTextLength"/> UTF-16 code units. A
/// missing or blank text finds nothing rather than failing.
/// </param>
/// <param name="WorkspaceId">
/// The workspace the passage is written in; only its titles are matched. Required. A workspace the
/// caller cannot read finds nothing.
/// </param>
/// <param name="ExcludeIds">
/// Items never to return, at most <see cref="FindMentionsHandler.MaximumExclusions"/>: the note
/// being written and the items it already links to.
/// </param>
internal sealed record MentionsRequest(string? Text, Guid? WorkspaceId, IReadOnlyList<Guid>? ExcludeIds);

/// <summary>One readable item whose title the passage names.</summary>
/// <param name="Item">The item.</param>
/// <param name="Phrase">
/// The words in the passage that matched, as they appear there (after Unicode NFC normalisation),
/// so a client can find and highlight them.
/// </param>
internal sealed record MentionResponse(SearchHitResponse Item, string Phrase);

/// <summary>What a mention match returned.</summary>
/// <param name="Mentions">The matches, longest phrase first.</param>
/// <param name="Truncated">
/// Whether the answer may be partial: the result ceiling was reached, or the passage held more
/// candidate phrases than are matched in one request and its tail was not considered.
/// </param>
internal sealed record MentionsResponse(IReadOnlyList<MentionResponse> Mentions, bool Truncated);
