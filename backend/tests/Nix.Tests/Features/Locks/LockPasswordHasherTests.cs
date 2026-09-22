using Nix.Features.Locks;

namespace Nix.Tests.Features.Locks;

/// <summary>
/// The verifier an item lock is checked against.
/// </summary>
public sealed class LockPasswordHasherTests
{
    [Fact]
    public void A_verifier_accepts_its_own_password_and_nothing_else()
    {
        var verifier = LockPasswordHasher.Hash("correct horse");

        Assert.True(LockPasswordHasher.Verify("correct horse", verifier));
        Assert.False(LockPasswordHasher.Verify("correct horsE", verifier));
        Assert.False(LockPasswordHasher.Verify(string.Empty, verifier));
    }

    /// <summary>
    /// A fresh salt per verifier, so two notes locked with the same password do not store the same
    /// value - and a leaked table does not say which notes share one.
    /// </summary>
    [Fact]
    public void The_same_password_never_produces_the_same_verifier_twice()
    {
        Assert.NotEqual(LockPasswordHasher.Hash("same"), LockPasswordHasher.Hash("same"));
    }

    [Fact]
    public void A_verifier_never_contains_the_password()
    {
        const string password = "plainly-visible-password";

        Assert.DoesNotContain(password, LockPasswordHasher.Hash(password), StringComparison.Ordinal);
    }

    /// <summary>
    /// The shape the database bound (32 to 256 characters) and the format parser both rely on.
    /// </summary>
    [Fact]
    public void A_verifier_names_its_scheme_and_cost_and_fits_the_column_bound()
    {
        var verifier = LockPasswordHasher.Hash("pass");

        Assert.StartsWith("pbkdf2-sha256$600000$", verifier, StringComparison.Ordinal);
        Assert.InRange(verifier.Length, 32, 256);
    }

    [Theory]
    [InlineData("")]
    [InlineData("not-a-verifier")]
    [InlineData("pbkdf2-sha256$0$AAAA$AAAA")]
    [InlineData("pbkdf2-sha256$1$!!!$AAAA")]
    [InlineData("argon2id$1$AAAA$AAAA")]
    [InlineData("pbkdf2-sha256$1$$")]
    public void A_malformed_verifier_fails_closed(string verifier)
    {
        Assert.False(LockPasswordHasher.Verify("anything", verifier));
    }

    [Fact]
    public void A_password_over_the_ceiling_is_refused_without_being_derived()
    {
        var verifier = LockPasswordHasher.Hash("pass");

        Assert.False(LockPasswordHasher.Verify(new string('x', LockPasswordHasher.MaximumLength + 1), verifier));
    }

    [Theory]
    [InlineData(null, false)]
    [InlineData("abc", false)]
    [InlineData("abcd", true)]
    public void Length_bounds_are_what_a_lock_accepts(string? password, bool acceptable)
    {
        Assert.Equal(acceptable, LockPasswordHasher.IsAcceptable(password));
        Assert.True(LockPasswordHasher.IsAcceptable(new string('x', LockPasswordHasher.MaximumLength)));
        Assert.False(LockPasswordHasher.IsAcceptable(new string('x', LockPasswordHasher.MaximumLength + 1)));
    }
}
