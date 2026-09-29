using Nix.Abstractions;
using Nix.Domain.Notifications;
using Nix.Domain.Primitives;
using Nix.Messaging;

namespace Nix.Features.Notifications;

/// <summary>
/// Validates a subscription the browser's Push API produced. The endpoint is attacker-chosen
/// input the worker will later POST to, so its origin is checked against a fixed allowlist here,
/// before it is ever stored - the same reasoning as every other outbound-URL boundary in Nix.
/// </summary>
public static class PushSubscriptionValidation
{
    /// <summary>The most devices one principal may have registered at once.</summary>
    public const int MaxSubscriptionsPerPrincipal = 10;

    private static readonly string[] AllowedOrigins =
    [
        "fcm.googleapis.com",
        "updates.push.services.mozilla.com",
        "web.push.apple.com",
    ];

    /// <summary>Whether an endpoint is a URL Nix will POST push messages to.</summary>
    public static bool IsAllowedEndpoint(string? endpoint)
    {
        if (string.IsNullOrWhiteSpace(endpoint) || endpoint.Length > 2048
            || !Uri.TryCreate(endpoint, UriKind.Absolute, out var uri) || uri.Scheme != Uri.UriSchemeHttps)
        {
            return false;
        }

        var host = uri.Host;
        return AllowedOrigins.Contains(host, StringComparer.OrdinalIgnoreCase)
            || host.EndsWith(".notify.windows.com", StringComparison.OrdinalIgnoreCase);
    }

    /// <summary>Whether a base64url string decodes to exactly the expected byte length.</summary>
    public static bool IsBase64UrlOfLength(string? value, int expectedBytes)
    {
        if (string.IsNullOrEmpty(value) || value.Length > 128)
        {
            return false;
        }

        var padded = value.Replace('-', '+').Replace('_', '/');
        padded = padded.PadRight(padded.Length + ((4 - (padded.Length % 4)) % 4), '=');
        try
        {
            return Convert.FromBase64String(padded).Length == expectedBytes;
        }
        catch (FormatException)
        {
            return false;
        }
    }

    /// <summary>Refuses a bad endpoint, an ill-shaped key, or a user agent that will not fit.</summary>
    public static bool IsValid(string? endpoint, string? p256dh, string? auth, string? userAgent) =>
        IsAllowedEndpoint(endpoint)
        && IsBase64UrlOfLength(p256dh, 65)
        && IsBase64UrlOfLength(auth, 16)
        && userAgent is not null && userAgent.Length <= 400;
}

/// <summary>Registers or refreshes a device for the session owner.</summary>
public sealed class AddPushSubscriptionHandler(IPushSubscriptionStore store, INixSessionContextAccessor session) : ICommandHandler<AddPushSubscription, PushSubscriptionDto>
{
    /// <inheritdoc />
    public async ValueTask<Result<PushSubscriptionDto>> HandleAsync(AddPushSubscription command, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(command);
        if (!PushSubscriptionValidation.IsValid(command.Endpoint, command.P256dh, command.Auth, command.UserAgent))
        {
            return Result.Failure<PushSubscriptionDto>(new NixError("notifications.invalid_subscription", "This device could not be registered for push."));
        }

        var context = session.Current ?? throw new InvalidOperationException("A session is required.");
        var existing = await store.CountAsync(context.TenantId, context.PrincipalId, cancellationToken).ConfigureAwait(false);
        var owned = await store.ListAsync(context.TenantId, context.PrincipalId, cancellationToken).ConfigureAwait(false);
        if (existing >= PushSubscriptionValidation.MaxSubscriptionsPerPrincipal && !owned.Any(row => row.Endpoint == command.Endpoint))
        {
            return Result.Failure<PushSubscriptionDto>(new NixError("notifications.too_many_subscriptions", "Remove a device before adding another."));
        }

        var saved = await store.SaveAsync(new PushSubscription
        {
            TenantId = context.TenantId,
            Id = Guid.CreateVersion7(),
            PrincipalId = context.PrincipalId,
            Endpoint = command.Endpoint,
            P256dh = command.P256dh,
            Auth = command.Auth,
            UserAgent = command.UserAgent,
            CreatedAt = DateTimeOffset.UtcNow,
            LastSuccessAt = null,
            Failures = 0,
        }, cancellationToken).ConfigureAwait(false);
        return Result.Success(new PushSubscriptionDto(saved.Id, saved.Endpoint, saved.UserAgent, saved.CreatedAt, saved.LastSuccessAt));
    }
}

/// <summary>Removes one of the session owner's own registered devices.</summary>
public sealed class RemovePushSubscriptionHandler(IPushSubscriptionStore store, INixSessionContextAccessor session) : ICommandHandler<RemovePushSubscription, bool>
{
    /// <inheritdoc />
    public async ValueTask<Result<bool>> HandleAsync(RemovePushSubscription command, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(command);
        var context = session.Current ?? throw new InvalidOperationException("A session is required.");
        var removed = await store.RemoveAsync(context.TenantId, context.PrincipalId, command.Endpoint, cancellationToken).ConfigureAwait(false);
        return Result.Success(removed);
    }
}
