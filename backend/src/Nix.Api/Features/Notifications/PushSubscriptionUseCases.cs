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
    public static bool IsAllowedEndpoint(string? endpoint) => Canonicalize(endpoint) is not null;

    /// <summary>
    /// Returns the one spelling of an allowed endpoint that is stored, matched on delete and handed
    /// to the push worker, or <see langword="null"/> when the endpoint is not allowed.
    /// </summary>
    /// <remarks>
    /// Real push-service endpoints are plain ASCII https URLs on the default port with no user
    /// information. Anything else (a non-ASCII path that would also overflow the index, a
    /// credential in the authority, an explicit port) is refused rather than normalised, so what
    /// the worker later POSTs to is exactly what was validated here.
    /// </remarks>
    public static string? Canonicalize(string? endpoint)
    {
        if (string.IsNullOrEmpty(endpoint) || endpoint.Length > 2048 || !System.Text.Ascii.IsValid(endpoint)
            || endpoint.Trim().Length != endpoint.Length
            || !Uri.TryCreate(endpoint, UriKind.Absolute, out var uri) || uri.Scheme != Uri.UriSchemeHttps
            || uri.UserInfo.Length != 0 || !uri.IsDefaultPort || uri.HostNameType != UriHostNameType.Dns)
        {
            return null;
        }

        var host = uri.Host;
        var allowed = AllowedOrigins.Contains(host, StringComparer.OrdinalIgnoreCase)
            || host.EndsWith(".notify.windows.com", StringComparison.OrdinalIgnoreCase);
        return allowed ? uri.AbsoluteUri : null;
    }

    /// <summary>Whether a strict base64url string decodes to exactly the expected byte length.</summary>
    public static bool IsBase64UrlOfLength(string? value, int expectedBytes) => DecodeBase64Url(value, expectedBytes) is not null;

    /// <summary>Refuses a bad endpoint, an ill-shaped key, or a user agent that will not fit.</summary>
    public static bool IsValid(string? endpoint, string? p256dh, string? auth, string? userAgent) =>
        IsAllowedEndpoint(endpoint)

        // An uncompressed P-256 point: 65 bytes starting 0x04, the only form RFC 8291 uses.
        && DecodeBase64Url(p256dh, 65) is [0x04, ..]
        && IsBase64UrlOfLength(auth, 16)
        && userAgent is not null && userAgent.Length <= 400;

    private static byte[]? DecodeBase64Url(string? value, int expectedBytes)
    {
        if (string.IsNullOrEmpty(value) || value.Length > 128 || !value.All(IsBase64UrlCharacter))
        {
            return null;
        }

        var padded = value.Replace('-', '+').Replace('_', '/');
        padded = padded.PadRight(padded.Length + ((4 - (padded.Length % 4)) % 4), '=');
        try
        {
            var bytes = Convert.FromBase64String(padded);
            return bytes.Length == expectedBytes ? bytes : null;
        }
        catch (FormatException)
        {
            return null;
        }
    }

    private static bool IsBase64UrlCharacter(char character) =>
        character is (>= 'A' and <= 'Z') or (>= 'a' and <= 'z') or (>= '0' and <= '9') or '-' or '_';
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
        var endpoint = PushSubscriptionValidation.Canonicalize(command.Endpoint)!;

        // Serialise this principal's registrations so two concurrent adds cannot both pass the cap.
        await store.LockAsync(context.TenantId, context.PrincipalId, cancellationToken).ConfigureAwait(false);
        var owned = await store.ListAsync(context.TenantId, context.PrincipalId, cancellationToken).ConfigureAwait(false);
        if (owned.Count >= PushSubscriptionValidation.MaxSubscriptionsPerPrincipal && !owned.Any(row => row.Endpoint == endpoint))
        {
            return Result.Failure<PushSubscriptionDto>(new NixError("notifications.too_many_subscriptions", "Remove a device before adding another."));
        }

        var saved = await store.SaveAsync(new PushSubscription
        {
            TenantId = context.TenantId,
            Id = Guid.CreateVersion7(),
            PrincipalId = context.PrincipalId,
            Endpoint = endpoint,
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
        var endpoint = PushSubscriptionValidation.Canonicalize(command.Endpoint);
        var removed = endpoint is not null
            && await store.RemoveAsync(context.TenantId, context.PrincipalId, endpoint, cancellationToken).ConfigureAwait(false);
        return Result.Success(removed);
    }
}
