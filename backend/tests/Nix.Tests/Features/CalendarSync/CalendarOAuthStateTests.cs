using Microsoft.AspNetCore.DataProtection;
using Nix.Authentication;
using Nix.Features.CalendarSync;

namespace Nix.Tests.Features.CalendarSync;

/// <summary>
/// The calendar connect state [SEC]: protected, ten minutes, bound to the principal, tenant,
/// provider and a nonce cookie, and carrying only a same-origin return path.
/// </summary>
public sealed class CalendarOAuthStateTests
{
    private static readonly Guid Tenant = new("0199a000-0000-7000-8000-0000000000a1");
    private static readonly Guid Principal = new("0199a000-0000-7000-8000-0000000000b1");
    private static readonly DateTimeOffset Issued = new(2026, 9, 30, 12, 0, 0, TimeSpan.Zero);

    private static CalendarOAuthStatePayload Payload(string returnTo = "/settings?tab=integrations") =>
        new("nonce-value", Tenant, Principal, "google", "verifier-value", Issued, returnTo);

    [Fact]
    public void A_state_round_trips_through_protection()
    {
        var protector = new CalendarTokenProtector(new EphemeralDataProtectionProvider());
        var protectedState = protector.ProtectState(CalendarOAuthState.Encode(Payload()), CalendarOAuthState.Lifetime);

        Assert.DoesNotContain("verifier-value", protectedState, StringComparison.Ordinal);
        var decoded = CalendarOAuthState.Decode(protector.UnprotectState(protectedState));
        Assert.Equal(Payload(), decoded);
        Assert.True(CalendarOAuthState.Accepts(decoded!, "nonce-value", Tenant, Principal, "google", Issued.AddMinutes(9)));
    }

    [Fact]
    public void A_tampered_or_foreign_state_does_not_unprotect()
    {
        var protector = new CalendarTokenProtector(new EphemeralDataProtectionProvider());
        var protectedState = protector.ProtectState(CalendarOAuthState.Encode(Payload()), CalendarOAuthState.Lifetime);

        var tampered = protectedState[..^2] + (protectedState[^2] == 'A' ? "B" : "A") + protectedState[^1];
        Assert.Null(protector.UnprotectState(tampered));
        Assert.Null(new CalendarTokenProtector(new EphemeralDataProtectionProvider()).UnprotectState(protectedState));
        Assert.Null(CalendarOAuthState.Decode("not\na\nstate"));
    }

    [Fact]
    public void A_state_older_than_ten_minutes_or_from_the_future_is_refused()
    {
        Assert.False(CalendarOAuthState.Accepts(Payload(), "nonce-value", Tenant, Principal, "google", Issued.AddMinutes(10).AddSeconds(1)));
        Assert.False(CalendarOAuthState.Accepts(Payload(), "nonce-value", Tenant, Principal, "google", Issued.AddMinutes(-5)));
    }

    [Fact]
    public void A_state_for_another_principal_tenant_provider_or_nonce_is_refused()
    {
        var now = Issued.AddMinutes(1);
        Assert.False(CalendarOAuthState.Accepts(Payload(), "nonce-value", Tenant, Guid.NewGuid(), "google", now));
        Assert.False(CalendarOAuthState.Accepts(Payload(), "nonce-value", Guid.NewGuid(), Principal, "google", now));
        Assert.False(CalendarOAuthState.Accepts(Payload(), "nonce-value", Tenant, Principal, "microsoft", now));
        Assert.False(CalendarOAuthState.Accepts(Payload(), "nonce-valuf", Tenant, Principal, "google", now));
        Assert.False(CalendarOAuthState.Accepts(Payload(), null, Tenant, Principal, "google", now));
        Assert.False(CalendarOAuthState.Accepts(Payload(), string.Empty, Tenant, Principal, "google", now));
    }

    [Theory]
    [InlineData("//evil.example/x")]
    [InlineData("https://evil.example/")]
    [InlineData("/\\evil.example")]
    [InlineData("/settings\u0000")]
    [InlineData("/set\ntings")]
    [InlineData("settings")]
    [InlineData("")]
    public void An_unsafe_return_path_falls_back(string returnTo)
    {
        Assert.False(ReturnToPath.IsSafe(returnTo));
        Assert.Equal("/fallback", ReturnToPath.Sanitize(returnTo, "/fallback"));

        // A state that somehow carried one decodes to the safe default, never the unsafe path.
        var decoded = CalendarOAuthState.Decode(CalendarOAuthState.Encode(Payload(returnTo)));
        Assert.Equal("/", decoded!.ReturnTo);
    }

    [Theory]
    [InlineData("/")]
    [InlineData("/w/0199a000-0000-7000-8000-000000000001/settings?tab=integrations")]
    public void A_same_origin_path_is_kept(string returnTo) =>
        Assert.Equal(returnTo, ReturnToPath.Sanitize(returnTo, "/fallback"));

    [Fact]
    public void Refresh_access_and_state_purposes_do_not_cross()
    {
        var protector = new CalendarTokenProtector(new EphemeralDataProtectionProvider());
        var refresh = protector.ProtectRefreshToken("refresh-secret");
        Assert.Equal("refresh-secret", protector.UnprotectRefreshToken(refresh));
        Assert.DoesNotContain("refresh-secret", System.Text.Encoding.UTF8.GetString(refresh), StringComparison.Ordinal);
        Assert.ThrowsAny<System.Security.Cryptography.CryptographicException>(() => protector.UnprotectAccessToken(refresh));
    }
}
