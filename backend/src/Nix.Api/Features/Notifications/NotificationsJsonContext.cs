using System.Text.Json.Serialization;

namespace Nix.Features.Notifications;

[JsonSourceGenerationOptions(PropertyNamingPolicy = JsonKnownNamingPolicy.CamelCase)]
[JsonSerializable(typeof(PrincipalPreferencesResponse))]
[JsonSerializable(typeof(PreferencesInput))]
[JsonSerializable(typeof(SavePreferencesRequest))]
[JsonSerializable(typeof(NotificationDto))]
[JsonSerializable(typeof(NotificationsPageResponse))]
[JsonSerializable(typeof(NotificationReadResponse))]
[JsonSerializable(typeof(PushSubscriptionDto))]
[JsonSerializable(typeof(AddPushSubscriptionRequest))]
[JsonSerializable(typeof(RemovePushSubscriptionRequest))]
[JsonSerializable(typeof(PushPublicKeyResponse))]
internal sealed partial class NotificationsJsonContext : JsonSerializerContext;
