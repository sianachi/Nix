using System.Text.Json.Serialization;
using Nix.Api.Features.Properties;
using Nix.Api.Features.Views;

namespace Nix.Api.Serialization;

/// <summary>
/// The structure feature's JSON contract, source-generated.
/// </summary>
/// <remarks>
/// One context per feature; <c>Program</c> chains them onto the serializer's resolver chain.
/// Adding a response type touches a file inside one feature rather than a file every feature
/// shares, which with several goals in flight is the difference between a merge conflict on all of
/// them and none.
/// </remarks>
[JsonSourceGenerationOptions(PropertyNamingPolicy = JsonKnownNamingPolicy.CamelCase)]
[JsonSerializable(typeof(EffectiveSchemaResponse))]
[JsonSerializable(typeof(SetSchemaRequest))]
[JsonSerializable(typeof(SetPropertiesRequest))]
[JsonSerializable(typeof(ContainerViewsResponse))]
[JsonSerializable(typeof(SetViewsRequest))]
internal sealed partial class StructureJsonContext : JsonSerializerContext;
