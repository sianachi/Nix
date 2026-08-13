using System.Text.Json.Serialization;
using Nix.Features.Calendar;

namespace Nix.Serialization;

/// <summary>
/// The calendar feature's JSON contract, source-generated.
/// </summary>
/// <remarks>
/// One context per feature; <c>Program</c> chains them all onto the serializer's resolver chain.
/// </remarks>
[JsonSourceGenerationOptions(PropertyNamingPolicy = JsonKnownNamingPolicy.CamelCase)]
[JsonSerializable(typeof(WorkspaceCalendarResponse))]
internal sealed partial class CalendarJsonContext : JsonSerializerContext;
