using System.Text.Json.Serialization;
using Nix.Features.Graph;

namespace Nix.Serialization;

/// <summary>
/// The graph feature's JSON contract, source-generated.
/// </summary>
/// <remarks>
/// One context per feature; <c>Program</c> chains them all onto the serializer's resolver chain.
/// </remarks>
[JsonSourceGenerationOptions(PropertyNamingPolicy = JsonKnownNamingPolicy.CamelCase)]
[JsonSerializable(typeof(WorkspaceGraphResponse))]
internal sealed partial class GraphJsonContext : JsonSerializerContext;
