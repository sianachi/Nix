using System.Text.Json.Serialization;
using Nix.Features.Query;

namespace Nix.Serialization;

/// <summary>
/// The query feature's JSON contract, source-generated.
/// </summary>
/// <remarks>
/// One context per feature; <c>Program</c> chains them all onto the serializer's resolver chain.
/// </remarks>
[JsonSourceGenerationOptions(PropertyNamingPolicy = JsonKnownNamingPolicy.CamelCase)]
[JsonSerializable(typeof(QueryResultsResponse))]
internal sealed partial class QueryJsonContext : JsonSerializerContext;
