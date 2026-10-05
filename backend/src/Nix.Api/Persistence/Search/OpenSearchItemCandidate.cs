using Nix.Domain.Items;
using Nix.Domain.Tenancy;

namespace Nix.Persistence.Search;

/// <summary>
/// One ranked hit as the derived OpenSearch index reports it, before Postgres has confirmed it.
/// </summary>
/// <param name="Id">The item the index ranked.</param>
/// <param name="WorkspaceId">The workspace the index believes it lives in.</param>
/// <param name="Type">The body type the index holds for it.</param>
/// <param name="Title">The title the index holds for it, which may lag a rename.</param>
/// <remarks>
/// <para>
/// <b>Deliberately not an <see cref="ItemDigest"/>.</b> A digest is the authoritative projection a
/// caller is shown, and it carries fields - the parent, the modification time - that the index does
/// not store and has no business inventing. <see cref="OpenSearchItemSearch"/> uses a candidate
/// only for its identifier and its place in the ranking, then resolves every candidate through
/// Postgres, which is where the digest the caller sees comes from.
/// </para>
/// <para>
/// The other fields are validated against the authorization scope the query was built with, which
/// is why they are read at all: a hit naming a workspace outside that scope is refused as escaped
/// rather than quietly resolved away.
/// </para>
/// </remarks>
public sealed record OpenSearchItemCandidate(ItemId Id, WorkspaceId WorkspaceId, string Type, string? Title);
