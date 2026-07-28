using System.Text.Json.Serialization;
using Nix.Features.Me;

namespace Nix.Serialization;

/// <summary>
/// The profile feature's JSON contract, source-generated.
/// </summary>
/// <remarks>
/// One context per feature; <c>Program</c> chains them all onto the serializer's resolver chain.
/// Adding a response type touches a file inside one feature rather than a file every feature
/// shares, which with several goals in flight is the difference between a merge conflict on all of
/// them and none.
/// </remarks>
[JsonSourceGenerationOptions(PropertyNamingPolicy = JsonKnownNamingPolicy.CamelCase)]
[JsonSerializable(typeof(CurrentPrincipalResponse))]
internal sealed partial class MeJsonContext : JsonSerializerContext;
