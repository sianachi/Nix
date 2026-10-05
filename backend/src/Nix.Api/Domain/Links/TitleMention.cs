using Nix.Domain.Items;

namespace Nix.Domain.Links;

/// <summary>
/// One readable item whose title appears, as a whole-word phrase, in a passage of text.
/// </summary>
/// <param name="Item">The item whose title matched.</param>
/// <param name="Phrase">
/// The normalised phrase that matched: lower-cased, single-spaced, exactly as
/// <see cref="MentionPhrases"/> cut it from the text.
/// </param>
/// <remarks>
/// An "unlinked mention" is the editor's reading of this: the text names a document it does not
/// yet link to. Whether it is already linked is the client's question, because only the client
/// holds the document's current references.
/// </remarks>
public sealed record TitleMention(ItemDigest Item, string Phrase);
