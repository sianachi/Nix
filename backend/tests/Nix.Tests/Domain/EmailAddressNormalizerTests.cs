using Nix.Domain.Identity;

namespace Nix.Tests.Domain;

public sealed class EmailAddressNormalizerTests
{
    [Fact]
    public void It_trims_normalizes_to_nfc_and_lowercases_invariantly()
    {
        Assert.True(EmailAddressNormalizer.TryNormalize("  U\u0308SER@EXAMPLE.COM  ", out var normalized));
        Assert.Equal("\u00fcser@example.com", normalized);
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("   ")]
    public void It_rejects_an_absent_or_empty_address(string? value) =>
        Assert.False(EmailAddressNormalizer.TryNormalize(value, out _));

    [Fact]
    public void It_rejects_a_normalized_address_over_the_utf8_bound()
    {
        var value = new string('\u00fc', 161);
        Assert.False(EmailAddressNormalizer.TryNormalize(value, out _));
    }

    [Fact]
    public void It_does_not_apply_provider_specific_alias_folding()
    {
        Assert.True(EmailAddressNormalizer.TryNormalize("person+tag@example.com", out var normalized));
        Assert.Equal("person+tag@example.com", normalized);
    }
}
