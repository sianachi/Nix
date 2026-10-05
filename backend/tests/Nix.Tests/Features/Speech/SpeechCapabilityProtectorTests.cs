using Microsoft.AspNetCore.DataProtection;
using Nix.Features.Speech;

namespace Nix.Tests.Features.Speech;

/// <summary>
/// The speech capability says who asked and for what, for five minutes, and says nothing at all
/// to anybody presenting something else.
/// </summary>
public sealed class SpeechCapabilityProtectorTests
{
    private static readonly Guid Tenant = new("11111111-1111-4111-8111-111111111111");
    private static readonly Guid Principal = new("1b1b1b1b-1111-4111-8111-1b1b1b1b1b1b");

    [Theory]
    [InlineData(SpeechCapabilityProtector.Synthesize)]
    [InlineData(SpeechCapabilityProtector.Dictate)]
    public void A_capability_redeems_to_the_principal_it_was_issued_to(string purpose)
    {
        var clock = new SettableClock(DateTimeOffset.UtcNow);
        var protector = new SpeechCapabilityProtector(new EphemeralDataProtectionProvider(), clock);

        var capability = protector.Issue(Tenant, Principal, purpose);
        var grant = protector.Redeem(capability.Token, purpose);

        Assert.NotNull(grant);
        Assert.Equal(Tenant, grant.TenantId);
        Assert.Equal(Principal, grant.PrincipalId);
        Assert.Equal(capability.ExpiresAt, grant.ExpiresAt);
        Assert.Equal(clock.GetUtcNow() + SpeechCapabilityProtector.Lifetime, capability.ExpiresAt);
        Assert.InRange(capability.Token.Length, 1, SpeechCapabilityProtector.MaximumTokenLength);
    }

    [Fact]
    public void A_capability_is_refused_for_the_other_purpose()
    {
        var protector = new SpeechCapabilityProtector(
            new EphemeralDataProtectionProvider(),
            new SettableClock(DateTimeOffset.UtcNow));

        var capability = protector.Issue(Tenant, Principal, SpeechCapabilityProtector.Synthesize);

        Assert.Null(protector.Redeem(capability.Token, SpeechCapabilityProtector.Dictate));
        Assert.NotNull(protector.Redeem(capability.Token, SpeechCapabilityProtector.Synthesize));
    }

    [Fact]
    public void A_capability_stops_redeeming_when_its_lifetime_has_passed_on_the_injected_clock()
    {
        var clock = new SettableClock(DateTimeOffset.UtcNow);
        var protector = new SpeechCapabilityProtector(new EphemeralDataProtectionProvider(), clock);
        var capability = protector.Issue(Tenant, Principal, SpeechCapabilityProtector.Dictate);

        clock.Now = capability.ExpiresAt.AddSeconds(-1);
        Assert.NotNull(protector.Redeem(capability.Token, SpeechCapabilityProtector.Dictate));

        clock.Now = capability.ExpiresAt;
        Assert.Null(protector.Redeem(capability.Token, SpeechCapabilityProtector.Dictate));
    }

    [Fact]
    public void A_capability_whose_sealed_expiry_is_in_the_past_is_refused_by_the_key_ring_itself()
    {
        // Issued by a clock ten minutes behind, so the expiry sealed into the payload has already
        // passed in real time. The injected clock would still accept it; the key ring does not.
        var clock = new SettableClock(DateTimeOffset.UtcNow.AddMinutes(-10));
        var protector = new SpeechCapabilityProtector(new EphemeralDataProtectionProvider(), clock);

        var capability = protector.Issue(Tenant, Principal, SpeechCapabilityProtector.Synthesize);

        Assert.Null(protector.Redeem(capability.Token, SpeechCapabilityProtector.Synthesize));
    }

    [Fact]
    public void A_tampered_capability_is_refused()
    {
        var protector = new SpeechCapabilityProtector(
            new EphemeralDataProtectionProvider(),
            new SettableClock(DateTimeOffset.UtcNow));
        var token = protector.Issue(Tenant, Principal, SpeechCapabilityProtector.Synthesize).Token;

        var middle = token.Length / 2;
        var replacement = token[middle] == 'A' ? 'B' : 'A';
        var tampered = string.Concat(token.AsSpan(0, middle), replacement.ToString(), token.AsSpan(middle + 1));

        Assert.Null(protector.Redeem(tampered, SpeechCapabilityProtector.Synthesize));
    }

    [Fact]
    public void A_capability_from_another_key_ring_is_refused()
    {
        var clock = new SettableClock(DateTimeOffset.UtcNow);
        var issued = new SpeechCapabilityProtector(new EphemeralDataProtectionProvider(), clock)
            .Issue(Tenant, Principal, SpeechCapabilityProtector.Synthesize);

        var other = new SpeechCapabilityProtector(new EphemeralDataProtectionProvider(), clock);

        Assert.Null(other.Redeem(issued.Token, SpeechCapabilityProtector.Synthesize));
    }

    [Fact]
    public void A_payload_protected_for_another_feature_is_not_a_speech_capability()
    {
        // Same key ring, same payload text, different purpose string: the purpose is what keeps a
        // value sealed for one feature from being replayed at another.
        var provider = new EphemeralDataProtectionProvider();
        var clock = new SettableClock(DateTimeOffset.UtcNow);
        var foreign = provider.CreateProtector("Nix.Calendar.OAuthState.v1")
            .ToTimeLimitedDataProtector()
            .Protect($"v1\n{Tenant:D}\n{Principal:D}\nsynthesize", clock.GetUtcNow().AddMinutes(5));

        var protector = new SpeechCapabilityProtector(provider, clock);

        Assert.Null(protector.Redeem(foreign, SpeechCapabilityProtector.Synthesize));
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("not-a-token")]
    [InlineData("!!!! not base64url !!!!")]
    public void Garbage_is_refused_without_throwing(string? token)
    {
        var protector = new SpeechCapabilityProtector(
            new EphemeralDataProtectionProvider(),
            new SettableClock(DateTimeOffset.UtcNow));

        Assert.Null(protector.Redeem(token, SpeechCapabilityProtector.Synthesize));
    }

    [Fact]
    public void An_overlong_token_is_refused_before_it_is_read()
    {
        var protector = new SpeechCapabilityProtector(
            new EphemeralDataProtectionProvider(),
            new SettableClock(DateTimeOffset.UtcNow));

        var overlong = new string('A', SpeechCapabilityProtector.MaximumTokenLength + 1);

        Assert.Null(protector.Redeem(overlong, SpeechCapabilityProtector.Synthesize));
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("Synthesize")]
    [InlineData("dictate ")]
    [InlineData("transcribe")]
    public void An_unknown_purpose_is_neither_issued_nor_redeemed(string? purpose)
    {
        var protector = new SpeechCapabilityProtector(
            new EphemeralDataProtectionProvider(),
            new SettableClock(DateTimeOffset.UtcNow));
        var token = protector.Issue(Tenant, Principal, SpeechCapabilityProtector.Synthesize).Token;

        Assert.False(SpeechCapabilityProtector.ValidPurpose(purpose));
        Assert.Null(protector.Redeem(token, purpose));
        Assert.ThrowsAny<ArgumentException>(() => protector.Issue(Tenant, Principal, purpose!));
    }

    private sealed class SettableClock(DateTimeOffset now) : TimeProvider
    {
        public DateTimeOffset Now { get; set; } = now;

        public override DateTimeOffset GetUtcNow() => Now;
    }
}
