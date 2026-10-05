using System.Text.Json.Serialization;

namespace Nix.Abstractions.Notifications;

/// <summary>
/// The durable job payload for the <c>notify.push</c> worker job (ADR-0051 section 5, contract N1):
/// only the notification's id. Everything the worker needs to render and deliver the push message
/// is fetched from N1's delivery endpoint under the leased job's own execution, never carried here.
/// </summary>
public sealed record NotifyPushJobPayload(
    [property: JsonPropertyName("notificationId")] Guid NotificationId);

[JsonSourceGenerationOptions(PropertyNamingPolicy = JsonKnownNamingPolicy.CamelCase)]
[JsonSerializable(typeof(NotifyPushJobPayload))]
public sealed partial class NotifyPushJobJsonContext : JsonSerializerContext;
