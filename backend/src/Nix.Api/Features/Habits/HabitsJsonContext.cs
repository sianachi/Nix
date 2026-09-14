using System.Text.Json.Serialization;
using Nix.Features.Habits;

namespace Nix.Serialization;

[JsonSourceGenerationOptions(PropertyNamingPolicy = JsonKnownNamingPolicy.CamelCase)]
[JsonSerializable(typeof(DateOnly?))]
[JsonSerializable(typeof(HabitSettingsRequest))]
[JsonSerializable(typeof(HabitStatusRequest))]
[JsonSerializable(typeof(HabitStatusResponse))]
[JsonSerializable(typeof(HabitCheckInRequest))]
[JsonSerializable(typeof(HabitTrackerResponse))]
[JsonSerializable(typeof(HabitCheckInResponse))]
internal sealed partial class HabitsJsonContext : JsonSerializerContext;
