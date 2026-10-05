using Nix.Messaging;

namespace Nix.Features.Notifications;

/// <summary>One registered device, as the client sees it. Never carries the encryption secrets back.</summary>
public sealed record PushSubscriptionDto(Guid Id, string Endpoint, string UserAgent, DateTimeOffset CreatedAt, DateTimeOffset? LastSuccessAt);

/// <summary>What the browser's Push API handed the client after a successful subscribe.</summary>
public sealed record AddPushSubscriptionRequest(string Endpoint, string P256dh, string Auth);

/// <summary>Registers, or refreshes, one device for Web Push.</summary>
public sealed record AddPushSubscription(string Endpoint, string P256dh, string Auth, string UserAgent) : ICommand<PushSubscriptionDto>;

/// <summary>Identifies the device to stop pushing to.</summary>
public sealed record RemovePushSubscriptionRequest(string Endpoint);

/// <summary>Removes one of the caller's own registered devices.</summary>
public sealed record RemovePushSubscription(string Endpoint) : ICommand<bool>;

/// <summary>The VAPID public key clients need to call the browser's Push API, or that push is unavailable.</summary>
public sealed record PushPublicKeyResponse(string PublicKey);
