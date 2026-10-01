using Nix.Features.Notifications;

namespace Nix.Tests.Features.Notifications;

public sealed class PushSubscriptionValidationTests
{
    private static string Base64Url(int byteCount) =>
        Convert.ToBase64String(new byte[byteCount]).TrimEnd('=').Replace('+', '-').Replace('/', '_');

    // A 65-byte key is valid only as an uncompressed P-256 point, which starts with 0x04.
    private static string UncompressedPoint()
    {
        var key = new byte[65];
        key[0] = 0x04;
        return Convert.ToBase64String(key).TrimEnd('=').Replace('+', '-').Replace('/', '_');
    }

    [Theory]
    [InlineData("https://fcm.googleapis.com/fcm/send/abc")]
    [InlineData("https://updates.push.services.mozilla.com/wpush/v2/abc")]
    [InlineData("https://web.push.apple.com/abc")]
    [InlineData("https://example.notify.windows.com/abc")]
    [InlineData("https://sub.example.notify.windows.com/abc")]
    public void Allowlisted_origins_are_accepted(string endpoint) =>
        Assert.True(PushSubscriptionValidation.IsAllowedEndpoint(endpoint));

    [Theory]
    [InlineData("http://fcm.googleapis.com/fcm/send/abc")] // not https
    [InlineData("https://attacker.example.com/collect")]
    [InlineData("https://notify.windows.com.attacker.example/abc")] // suffix trick
    [InlineData("https://fcm.googleapis.com.attacker.example/abc")]
    [InlineData("https://user:pw@fcm.googleapis.com/fcm/send/abc")] // credentials in the authority
    [InlineData("https://fcm.googleapis.com:8443/fcm/send/abc")] // explicit non-default port
    [InlineData(" https://fcm.googleapis.com/fcm/send/abc")] // surrounding whitespace
    [InlineData("https://fcm.googleapis.com/fcm/send/abc\n")]
    [InlineData("https://fcm.googleapis.com/fcm/send/\u6F22\u5B57")] // non-ASCII path
    [InlineData("https://142.250.0.1/fcm/send/abc")] // IP literal
    [InlineData(null)]
    [InlineData("")]
    [InlineData("not a url")]
    public void Everything_else_is_refused(string? endpoint) =>
        Assert.False(PushSubscriptionValidation.IsAllowedEndpoint(endpoint));

    [Fact]
    public void Keys_must_decode_to_exactly_the_expected_byte_length()
    {
        Assert.True(PushSubscriptionValidation.IsBase64UrlOfLength(Base64Url(65), 65));
        Assert.True(PushSubscriptionValidation.IsBase64UrlOfLength(Base64Url(16), 16));
        Assert.False(PushSubscriptionValidation.IsBase64UrlOfLength(Base64Url(64), 65));
        Assert.False(PushSubscriptionValidation.IsBase64UrlOfLength(Base64Url(17), 16));
        Assert.False(PushSubscriptionValidation.IsBase64UrlOfLength(null, 65));
        Assert.False(PushSubscriptionValidation.IsBase64UrlOfLength("not-base64!!", 65));
    }

    [Fact]
    public void The_stored_endpoint_is_one_canonical_spelling()
    {
        Assert.Equal("https://fcm.googleapis.com/fcm/send/abc",
            PushSubscriptionValidation.Canonicalize("https://FCM.googleapis.com:443/fcm/send/abc"));
        Assert.Null(PushSubscriptionValidation.Canonicalize("https://attacker.example.com/"));
    }

    [Fact]
    public void Keys_use_the_strict_base64url_alphabet()
    {
        var standard = Convert.ToBase64String(Enumerable.Repeat((byte)0xFB, 16).ToArray()).TrimEnd('=');
        Assert.Contains("+", standard, StringComparison.Ordinal);
        Assert.False(PushSubscriptionValidation.IsBase64UrlOfLength(standard, 16));
        Assert.False(PushSubscriptionValidation.IsBase64UrlOfLength(Base64Url(16).Insert(4, " "), 16));
    }

    [Fact]
    public void A_full_subscription_is_valid_only_when_every_part_is()
    {
        var p256dh = UncompressedPoint();
        var auth = Base64Url(16);
        Assert.True(PushSubscriptionValidation.IsValid("https://fcm.googleapis.com/fcm/send/abc", p256dh, auth, "Mozilla/5.0"));
        Assert.False(PushSubscriptionValidation.IsValid("https://attacker.example.com", p256dh, auth, "Mozilla/5.0"));
        Assert.False(PushSubscriptionValidation.IsValid("https://fcm.googleapis.com/fcm/send/abc", Base64Url(64), auth, "Mozilla/5.0"));
        Assert.False(PushSubscriptionValidation.IsValid("https://fcm.googleapis.com/fcm/send/abc", p256dh, auth, new string('a', 401)));
        Assert.False(PushSubscriptionValidation.IsValid("https://fcm.googleapis.com/fcm/send/abc", Base64Url(65), auth, "Mozilla/5.0"));
    }
}
