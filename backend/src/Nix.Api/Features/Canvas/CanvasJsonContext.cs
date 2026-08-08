using System.Text.Json.Serialization;
using Nix.Features.Canvas;

namespace Nix.Serialization;

/// <summary>
/// The canvas library feature's JSON contract, source-generated.
/// </summary>
/// <remarks>
/// One context per feature; <c>Program</c> chains them all onto the serializer's resolver chain.
/// </remarks>
[JsonSourceGenerationOptions(PropertyNamingPolicy = JsonKnownNamingPolicy.CamelCase)]
[JsonSerializable(typeof(CanvasLibraryResponse))]
[JsonSerializable(typeof(SaveCanvasLibraryRequest))]
internal sealed partial class CanvasJsonContext : JsonSerializerContext;
