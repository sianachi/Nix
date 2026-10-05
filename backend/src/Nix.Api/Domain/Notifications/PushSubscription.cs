using Nix.Domain.Identity;
using Nix.Domain.Tenancy;

namespace Nix.Domain.Notifications;

/// <summary>One browser or device registered to receive Web Push for a principal.</summary>
public sealed class PushSubscription
{
    /// <summary>Gets the tenant, carried for row-level security.</summary>
    public required TenantId TenantId { get; init; }

    /// <summary>Gets the identity of this subscription.</summary>
    public required Guid Id { get; init; }

    /// <summary>Gets the owner.</summary>
    public required PrincipalId PrincipalId { get; init; }

    /// <summary>
    /// Gets the push service URL the worker POSTs to. Attacker-chosen input from the browser's
    /// Push API; only ever used after its origin is checked against the push-service allowlist.
    /// </summary>
    public required string Endpoint { get; init; }

    /// <summary>Gets the subscriber's base64url-encoded P-256 public key, used to encrypt the payload.</summary>
    public required string P256dh { get; init; }

    /// <summary>Gets the base64url-encoded authentication secret, used to encrypt the payload.</summary>
    public required string Auth { get; init; }

    /// <summary>Gets the browser's user agent string at subscription time, for the device list only.</summary>
    public required string UserAgent { get; init; }

    /// <summary>Gets when this subscription was registered.</summary>
    public required DateTimeOffset CreatedAt { get; init; }

    /// <summary>Gets when a push last delivered successfully, or <see langword="null"/> if never.</summary>
    public DateTimeOffset? LastSuccessAt { get; init; }

    /// <summary>Gets the count of consecutive delivery failures. Five removes the subscription.</summary>
    public required int Failures { get; init; }
}
