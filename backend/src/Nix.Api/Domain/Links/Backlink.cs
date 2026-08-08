using Nix.Domain.Items;

namespace Nix.Domain.Links;

/// <summary>
/// One document that refers to the item being read, and how often.
/// </summary>
/// <param name="Source">The item whose document holds the reference.</param>
/// <param name="Occurrences">How many times it refers to the target.</param>
/// <remarks>
/// The target is not carried: a caller asked about one item and got the list of what points at it,
/// so repeating the answer on every row would be a column with one value in it.
/// </remarks>
public sealed record Backlink(ItemDigest Source, int Occurrences);
