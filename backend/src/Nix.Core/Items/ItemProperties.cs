using System.Text.Json;
using System.Text.Json.Nodes;

namespace Nix.Core.Items;

/// <summary>
/// Reads and writes the well-known members of an item's property bag.
/// </summary>
/// <remarks>
/// <para>
/// <b>Why the title lives here rather than in a column.</b> The entity model gives an item no
/// title of its own: a name is one of the schema-driven properties an item carries, like any
/// other, and the M0 schema follows that. The API promotes it to a first-class field because every
/// client needs it to render a row, and this is the mapping that makes the promotion honest.
/// </para>
/// <para>
/// The cost is a small JSON parse per item read, which is fine at a page of fifty and is not
/// where this should stay. The goal that introduces property schemas owns the typed
/// representation, and the moment properties are validated on write it should also own an
/// expression index over the title - ordering a folder by name is a query nobody can serve from a
/// string parse.
/// </para>
/// <para>
/// Missing, null, or non-string titles all read as empty rather than throwing. A property bag is
/// client-influenced data and a malformed one is a display problem, not a reason to fail the
/// request that listed it.
/// </para>
/// </remarks>
public static class ItemProperties
{
    /// <summary>
    /// Merges a set of changes into a property bag.
    /// </summary>
    /// <param name="properties">The stored bag, or <see langword="null"/> when the item has none.</param>
    /// <param name="changes">The properties to set, as a JSON object.</param>
    /// <returns>
    /// The merged bag, or <see langword="null"/> when the changes are not a JSON object.
    /// </returns>
    /// <remarks>
    /// <para>
    /// <b>A merge rather than a replacement</b>, because a caller sets the properties it is
    /// changing and knows nothing about the rest. A board that replaced the bag would drop every
    /// property it does not display, which is most of them.
    /// </para>
    /// <para>
    /// <b>An explicit null removes the key.</b> That is what a client clearing a field sends, and
    /// keeping a null around would leave "set but empty" and "not set" indistinguishable to
    /// everything downstream - including the required check, which would then be satisfiable by
    /// sending null.
    /// </para>
    /// </remarks>
    public static string? Merge(string? properties, string changes)
    {
        ArgumentNullException.ThrowIfNull(changes);

        JsonNode? parsed;
        try
        {
            parsed = JsonNode.Parse(changes);
        }
        catch (JsonException)
        {
            return null;
        }

        if (parsed is not JsonObject incoming)
        {
            return null;
        }

        var bag = ReadObject(properties) ?? new JsonObject();

        foreach (var change in incoming)
        {
            if (change.Value is null)
            {
                bag.Remove(change.Key);
                continue;
            }

            // Deep-cloned because a node belongs to exactly one parent: assigning it straight
            // across would detach it from the document being read and leave that one malformed.
            bag[change.Key] = change.Value.DeepClone();
        }

        return bag.ToJsonString();
    }

    private static JsonObject? ReadObject(string? properties)
    {
        if (string.IsNullOrWhiteSpace(properties))
        {
            return null;
        }

        try
        {
            return JsonNode.Parse(properties) as JsonObject;
        }
        catch (JsonException)
        {
            return null;
        }
    }

    /// <summary>The property an item's display name is stored under.</summary>
    public const string TitleKey = "title";

    /// <summary>
    /// Reads the title out of a property bag.
    /// </summary>
    /// <param name="properties">The stored JSON object, or <see langword="null"/>.</param>
    /// <returns>The title, or an empty string when there is none.</returns>
    public static string ReadTitle(string? properties)
    {
        if (string.IsNullOrWhiteSpace(properties))
        {
            return string.Empty;
        }

        try
        {
            return JsonNode.Parse(properties) is JsonObject bag
                && bag.TryGetPropertyValue(TitleKey, out var title)
                && title is JsonValue value
                && value.TryGetValue<string>(out var text)
                    ? text
                    : string.Empty;
        }
        catch (JsonException)
        {
            // Unparseable properties are a display problem for one row, not a reason to fail the
            // request that listed it. The write path is what should have prevented this.
            return string.Empty;
        }
    }

    /// <summary>
    /// Returns a property bag with the title set, preserving every other member.
    /// </summary>
    /// <param name="properties">The existing bag, or <see langword="null"/> to start a new one.</param>
    /// <param name="title">The title to store.</param>
    /// <returns>The updated JSON object.</returns>
    /// <remarks>
    /// Preserving the rest matters: a rename must not silently drop properties a later goal added,
    /// and "read, replace one key, write the whole bag" is the only shape that survives a schema
    /// this code does not yet know about.
    /// </remarks>
    public static string WithTitle(string? properties, string title)
    {
        ArgumentNullException.ThrowIfNull(title);

        JsonObject bag;
        try
        {
            bag = string.IsNullOrWhiteSpace(properties)
                ? []
                : JsonNode.Parse(properties) as JsonObject ?? [];
        }
        catch (JsonException)
        {
            bag = [];
        }

        bag[TitleKey] = title;
        return bag.ToJsonString();
    }
}
