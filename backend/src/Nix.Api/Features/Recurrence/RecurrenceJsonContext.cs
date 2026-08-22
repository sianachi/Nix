using System.Text.Json.Serialization;
using Nix.Features.Recurrence;

namespace Nix.Serialization;

/// <summary>
/// The recurrence feature's JSON contract, source-generated.
/// </summary>
/// <remarks>
/// One context per feature; <c>Program</c> chains them all onto the serializer's resolver chain.
/// </remarks>
[JsonSourceGenerationOptions(PropertyNamingPolicy = JsonKnownNamingPolicy.CamelCase)]
[JsonSerializable(typeof(SetRecurrenceRequest))]
[JsonSerializable(typeof(SetRecurrenceResponse))]
[JsonSerializable(typeof(CompleteOccurrenceRequest))]
[JsonSerializable(typeof(CompleteOccurrenceResponse))]
internal sealed partial class RecurrenceJsonContext : JsonSerializerContext;
