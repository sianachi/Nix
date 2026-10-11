using Microsoft.AspNetCore.Http;
using Microsoft.EntityFrameworkCore;
using Nix.Domain.Sites;
using Nix.Features.Sites;
using Npgsql;

namespace Nix.Tests.Features.Sites;

public sealed class SiteRulesTests
{
    [Fact]
    public void A_deadlock_is_recognised_through_wrapping_exceptions_and_nothing_else_is()
    {
        var deadlock = new PostgresException("deadlock detected", "ERROR", "ERROR", PostgresErrorCodes.DeadlockDetected);

        Assert.True(SiteErrors.IsDeadlock(deadlock));
        Assert.True(SiteErrors.IsDeadlock(new DbUpdateException("save", deadlock)));
        Assert.False(SiteErrors.IsDeadlock(new PostgresException("unique", "ERROR", "ERROR", PostgresErrorCodes.UniqueViolation)));
        Assert.False(SiteErrors.IsDeadlock(new InvalidOperationException()));
        Assert.Equal(StatusCodes.Status409Conflict, SiteErrors.StatusFor(SiteErrors.Deadlocked().Code));
    }

    [Theory]
    [InlineData("nix", true)]
    [InlineData("nix-docs", true)]
    [InlineData("a1", true)]
    [InlineData("n", false)]
    [InlineData("-nix", false)]
    [InlineData("nix-", false)]
    [InlineData("ni--x", false)]
    [InlineData("Nix", false)]
    [InlineData("nix_docs", false)]
    [InlineData("a12345678901234567890123456789012345678901", false)]
    [InlineData("a123456789012345678901234567890123456789", true)]
    public void A_slug_is_two_to_forty_lowercase_characters_with_single_hyphens(string slug, bool valid)
    {
        Assert.Equal(valid, SiteRules.IsSlug(slug));
    }

    [Theory]
    [InlineData("/", true)]
    [InlineData("/guide/", true)]
    [InlineData("/blog/hello-world/", true)]
    [InlineData("", false)]
    [InlineData("guide/", false)]
    [InlineData("/guide", false)]
    [InlineData("//", false)]
    [InlineData("/Guide/", false)]
    [InlineData("/-guide/", false)]
    [InlineData("/a b/", false)]
    [InlineData("/../", false)]
    public void A_path_is_slash_terminated_lowercase_segments(string path, bool valid)
    {
        Assert.Equal(valid, SiteRules.IsPath(path));
    }

    [Theory]
    [InlineData("docs.example.com", true)]
    [InlineData("a.b.c.example.com", true)]
    [InlineData("sites.localhost", true)]
    [InlineData("localhost", false)]
    [InlineData("Docs.example.com", false)]
    [InlineData("docs..example.com", false)]
    [InlineData("-docs.example.com", false)]
    [InlineData("docs.example.123", false)]
    [InlineData("192.168.0.1", false)]
    [InlineData("docs.example.com/", false)]
    public void A_hostname_is_a_lowercase_dns_name_with_at_least_two_labels(string hostname, bool valid)
    {
        Assert.Equal(valid, SiteRules.IsHostname(hostname));
    }

    [Theory]
    [InlineData("Getting Started", "getting-started")]
    [InlineData("  Hello,   World!  ", "hello-world")]
    [InlineData("Café crème", "cafe-creme")]
    [InlineData("Ünïcödé ñame", "unicode-name")]
    [InlineData("100% #1 (really)", "100-1-really")]
    [InlineData("---", "untitled")]
    [InlineData("", "untitled")]
    [InlineData(null, "untitled")]
    [InlineData("日本語", "untitled")]
    public void A_title_becomes_one_ascii_path_segment(string? title, string expected)
    {
        Assert.Equal(expected, SiteRules.Slugify(title));
    }

    [Fact]
    public void A_long_title_is_cut_at_eighty_characters_without_a_trailing_hyphen()
    {
        var slug = SiteRules.Slugify(new string('a', 79) + " tail");

        Assert.Equal(79, slug.Length);
        Assert.False(slug.EndsWith('-'));
        Assert.True(SiteRules.IsPath("/" + slug + "/"));
    }

    [Fact]
    public void A_derived_path_sits_under_its_parent()
    {
        Assert.Equal("/guide/install/", SiteRules.DerivePath("/guide/", "Install", _ => false));
        Assert.Equal("/getting-started/", SiteRules.DerivePath("/", "Getting Started", _ => false));
    }

    [Fact]
    public void A_collision_takes_the_next_numeric_suffix()
    {
        var taken = new HashSet<string> { "/guide/install/", "/guide/install-2/", "/guide/install-3/" };

        Assert.Equal("/guide/install-4/", SiteRules.DerivePath("/guide/", "Install", taken.Contains));
    }

    [Fact]
    public void A_suffix_never_pushes_a_segment_past_eighty_characters()
    {
        var title = new string('a', 80);
        var taken = new HashSet<string> { "/" + title + "/" };

        var path = SiteRules.DerivePath("/", title, taken.Contains);

        Assert.True(SiteRules.IsPath(path));
        Assert.EndsWith("-2/", path, StringComparison.Ordinal);
    }

    [Fact]
    public void A_derived_path_is_always_a_valid_path_for_hostile_titles()
    {
        foreach (var title in new[] { "<script>alert(1)</script>", "../../etc/passwd", "a/b\\c", "\0\u202e", "%2e%2e", "\u2603\u00e9" })
        {
            Assert.True(SiteRules.IsPath(SiteRules.DerivePath("/", title, _ => false)), title);
        }
    }

    [Theory]
    [InlineData("#2f5fd0", true)]
    [InlineData("#2F5FD0", false)]
    [InlineData("2f5fd0", false)]
    [InlineData("#2f5fd", false)]
    [InlineData("red", false)]
    public void An_accent_is_a_lowercase_six_digit_hex_colour(string color, bool valid)
    {
        Assert.Equal(valid, SiteRules.IsAccent(color));
    }

    [Fact]
    public void A_host_manifest_key_is_derived_from_the_lowercase_hostname()
    {
        Assert.Equal("sites/_hosts/docs.example.com.json", SiteRules.HostKey("docs.example.com"));
        Assert.Equal("docs.example.com", SiteRules.NormalizeHost("  Docs.Example.COM. "));
    }

    [Theory]
    [InlineData("www", true, true)]
    [InlineData("home", true, true)]
    [InlineData("collab", true, true)]
    [InlineData("nix", true, false)]
    [InlineData("osinachi", true, false)]
    [InlineData("my-notes", false, false)]
    public void Infrastructure_and_owner_slugs_are_reserved(string slug, bool reserved, bool infrastructure)
    {
        Assert.Equal(reserved, SiteRules.IsReservedSlug(slug));
        Assert.Equal(infrastructure, SiteRules.IsInfrastructureSlug(slug));
    }
}
