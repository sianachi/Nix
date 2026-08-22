using System.Text.Json.Serialization;
using Nix.Features.Charts;

namespace Nix.Serialization;

/// <summary>
/// The chart feature's JSON contract, source-generated.
/// </summary>
/// <remarks>
/// One context per feature; <c>Program</c> chains them all onto the serializer's resolver chain.
/// </remarks>
[JsonSourceGenerationOptions(PropertyNamingPolicy = JsonKnownNamingPolicy.CamelCase)]
[JsonSerializable(typeof(ChartResponse))]
internal sealed partial class ChartJsonContext : JsonSerializerContext;
