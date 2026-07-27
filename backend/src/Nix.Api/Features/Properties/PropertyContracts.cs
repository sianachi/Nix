using System.Text.Json.Nodes;

namespace Nix.Api.Features.Properties;

/// <summary>
/// One property a schema declares, as the API presents it.
/// </summary>
/// <param name="Key">The stable key the value is stored under.</param>
/// <param name="Label">What a person sees. The only part safe to rename.</param>
/// <param name="Type">
/// One of <c>text</c>, <c>number</c>, <c>select</c>, <c>multi_select</c>, <c>date</c>,
/// <c>checkbox</c>, <c>url</c>.
/// </param>
/// <param name="Options">The values a select accepts, in offer order. Empty for other types.</param>
/// <param name="Required">Whether a write must supply a value.</param>
/// <remarks>
/// <see cref="Type"/> is an open string rather than an enumeration, for the same reason an item's
/// kind is: adding a property type should be a feature, not a breaking change to every generated
/// client. A client that meets a type it does not know should render the raw value rather than
/// fail to parse the schema.
/// </remarks>
internal sealed record PropertyDefinitionResponse(
    string Key,
    string Label,
    string Type,
    IReadOnlyList<string> Options,
    bool Required);

/// <summary>
/// The property schema in force at an item.
/// </summary>
/// <param name="Properties">Every ancestor's declaration merged, nearest winning.</param>
/// <param name="Declared">
/// What this item declares itself, which is the subset an editor may change here.
/// </param>
/// <param name="Inherit">Whether ancestors above this item contribute.</param>
/// <remarks>
/// <b>Both lists are returned, and the difference matters.</b> An editor showing only the merged
/// result would save every inherited property back onto the item, silently converting inheritance
/// into a copy - after which changing the parent's schema would stop reaching the child.
/// </remarks>
internal sealed record EffectiveSchemaResponse(
    IReadOnlyList<PropertyDefinitionResponse> Properties,
    IReadOnlyList<PropertyDefinitionResponse> Declared,
    bool Inherit);

/// <summary>
/// Replaces the schema an item declares for its subtree.
/// </summary>
/// <param name="Properties">The properties to declare. An empty list declares none.</param>
/// <param name="Inherit">
/// Whether ancestors above this item contribute. False makes this the outermost schema its subtree
/// sees, which is what a scratch folder under a heavily-schema'd workspace needs.
/// </param>
internal sealed record SetSchemaRequest(
    IReadOnlyList<PropertyDefinitionRequest> Properties,
    bool Inherit);

/// <summary>One property being declared.</summary>
/// <param name="Key">The stable key.</param>
/// <param name="Label">What a person sees.</param>
/// <param name="Type">The property type.</param>
/// <param name="Options">The values a select accepts.</param>
/// <param name="Required">Whether a write must supply a value.</param>
internal sealed record PropertyDefinitionRequest(
    string Key,
    string Label,
    string Type,
    IReadOnlyList<string>? Options,
    bool Required);

/// <summary>
/// Writes property values onto an item.
/// </summary>
/// <param name="Properties">
/// The properties to set. A member set to null clears that property; anything not mentioned is
/// left alone.
/// </param>
/// <remarks>
/// <b>A merge, not a replacement.</b> A board dragging a card between columns sends one property;
/// replacing the bag would drop every other property the item carries, which is most of them.
/// </remarks>
internal sealed record SetPropertiesRequest(JsonObject Properties);
