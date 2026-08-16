using Nix.Domain.Identity;

namespace Nix.Tests.Domain;

/// <summary>
/// The token string's arithmetic: minting, recognising the shape, and the hash comparison that is
/// the actual authentication.
/// </summary>
public sealed class PersonalAccessTokenSecretTests
{
    [Fact]
    public void A_minted_token_has_the_documented_shape()
    {
        var minted = PersonalAccessTokenSecret.Mint();

        Assert.Equal(PersonalAccessTokenSecret.TokenLength, minted.Token.Length);
        Assert.StartsWith(PersonalAccessTokenSecret.Prefix, minted.Token, StringComparison.Ordinal);
        Assert.Equal(12, minted.Lookup.Length);
        Assert.Equal(32, minted.Hash.Length);
    }

    [Fact]
    public void The_lookup_read_back_from_the_token_is_the_minted_lookup()
    {
        var minted = PersonalAccessTokenSecret.Mint();

        Assert.True(PersonalAccessTokenSecret.TryReadLookup(minted.Token, out var lookup));
        Assert.Equal(minted.Lookup, lookup);
    }

    [Fact]
    public void The_minted_hash_matches_the_minted_token_and_nothing_else()
    {
        var minted = PersonalAccessTokenSecret.Mint();
        var other = PersonalAccessTokenSecret.Mint();

        Assert.True(PersonalAccessTokenSecret.Matches(minted.Hash, minted.Token));
        Assert.False(PersonalAccessTokenSecret.Matches(minted.Hash, other.Token));
    }

    [Fact]
    public void Changing_one_character_of_the_secret_half_fails_the_comparison()
    {
        var minted = PersonalAccessTokenSecret.Mint();
        var last = minted.Token[^1];
        var tampered = minted.Token[..^1] + (last == 'A' ? 'B' : 'A');

        Assert.False(PersonalAccessTokenSecret.Matches(minted.Hash, tampered));
    }

    [Fact]
    public void Two_mints_never_share_a_lookup_or_a_secret()
    {
        var first = PersonalAccessTokenSecret.Mint();
        var second = PersonalAccessTokenSecret.Mint();

        Assert.NotEqual(first.Lookup, second.Lookup);
        Assert.NotEqual(first.Token, second.Token);
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("nixpat_short")]
    public void A_value_without_the_shape_is_not_read(string? presented)
    {
        Assert.False(PersonalAccessTokenSecret.TryReadLookup(presented, out _));
    }

    [Fact]
    public void A_lookup_outside_its_alphabet_is_not_read()
    {
        // Right length, right prefix, but the lookup half carries characters the mint never
        // produces - the shape check must refuse before any database sees the string.
        var outsideAlphabet =
            PersonalAccessTokenSecret.Prefix + "ABCDEFGHIJKL" + new string('a', 43);

        Assert.Equal(PersonalAccessTokenSecret.TokenLength, outsideAlphabet.Length);
        Assert.False(PersonalAccessTokenSecret.TryReadLookup(outsideAlphabet, out _));
    }

    [Fact]
    public void A_token_of_the_right_length_but_the_wrong_prefix_is_not_read()
    {
        var minted = PersonalAccessTokenSecret.Mint();
        var wrongPrefix = "nixPAT_" + minted.Token[PersonalAccessTokenSecret.Prefix.Length..];

        Assert.Equal(PersonalAccessTokenSecret.TokenLength, wrongPrefix.Length);
        Assert.False(PersonalAccessTokenSecret.TryReadLookup(wrongPrefix, out _));
    }

    [Fact]
    public void The_hash_is_over_the_whole_string_so_prefix_and_secret_both_bind()
    {
        var minted = PersonalAccessTokenSecret.Mint();
        var expected = PersonalAccessTokenSecret.Hash(minted.Token);

        Assert.True(expected.Span.SequenceEqual(minted.Hash.Span));
    }
}
