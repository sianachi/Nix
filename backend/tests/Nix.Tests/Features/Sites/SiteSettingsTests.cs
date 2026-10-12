using Nix.Domain.Sites;
using Nix.Features.Sites;

namespace Nix.Tests.Features.Sites;

public sealed class SiteSettingsTests
{
    [Fact]
    public void The_default_settings_are_valid_and_carry_the_root_title()
    {
        var settings = SiteSettings.Default("Nix Docs");

        Assert.Null(settings.Validate());
        Assert.Equal("Nix Docs", settings.Name);
        Assert.True(settings.BuiltWithNix);
    }

    [Fact]
    public void A_very_long_default_name_is_clipped_not_refused()
    {
        Assert.Null(SiteSettings.Default(new string('x', 400)).Validate());
    }

    [Fact]
    public void Every_bound_is_checked()
    {
        var valid = SiteSettings.Default("Docs");

        Assert.NotNull((valid with { Name = " " }).Validate());
        Assert.NotNull((valid with { Name = new string('x', 121) }).Validate());
        Assert.NotNull((valid with { Description = new string('x', 501) }).Validate());
        Assert.NotNull((valid with { Accent = "blue" }).Validate());
        Assert.NotNull((valid with { FooterText = new string('x', 301) }).Validate());
        Assert.NotNull((valid with { Language = "en us" }).Validate());
        Assert.NotNull((valid with { Name = "bad\nname" }).Validate());
        Assert.NotNull((valid with { Navigation = [.. Enumerable.Range(0, 21).Select(i => new SiteNavLink("l" + i, "/a/"))] }).Validate());
        Assert.NotNull((valid with { Navigation = [new SiteNavLink("Home", "home")] }).Validate());
        Assert.NotNull((valid with { Navigation = [new SiteNavLink(string.Empty, "/home/")] }).Validate());
        Assert.Null((valid with { Navigation = [new SiteNavLink("Home", "/")] }).Validate());
    }

    [Fact]
    public void Settings_are_normalized_by_the_checker_the_endpoints_use()
    {
        var checkedSettings = SiteViews.CheckSettings(new SiteSettingsDto(
            "  Docs  ", "d", "#2f5fd0", [new SiteNavLinkDto("Guide", "/guide/")], "f", BuiltWithNix: false, "en"));

        Assert.True(checkedSettings.IsSuccess);
        Assert.Equal("Docs", checkedSettings.Value.Name);
        Assert.False(checkedSettings.Value.BuiltWithNix);
        Assert.True(SiteViews.CheckSettings(null).IsFailure);
        Assert.Equal(
            SiteErrors.InvalidCode,
            SiteViews.CheckSettings(new SiteSettingsDto("n", "d", "nope", [], "f", true, "en")).Error.Code);
    }

    [Theory]
    [InlineData(SiteErrors.NotFoundCode, 404)]
    [InlineData(SiteErrors.ItemNotFoundCode, 404)]
    [InlineData(SiteErrors.ManagerRequiredCode, 403)]
    [InlineData(SiteErrors.NotConfiguredCode, 503)]
    [InlineData(SiteErrors.InvalidCode, 422)]
    [InlineData(SiteErrors.DisclosureRequiredCode, 422)]
    [InlineData(SiteErrors.TooManyPagesCode, 422)]
    [InlineData(SiteErrors.RootLockedCode, 409)]
    [InlineData(SiteErrors.SlugTakenCode, 409)]
    [InlineData(SiteErrors.BuildInProgressCode, 409)]
    [InlineData(SiteErrors.PathTakenCode, 409)]
    public void Each_failure_code_is_published_with_its_status(string code, int status)
    {
        Assert.Equal(status, SiteErrors.StatusFor(code));
    }
}
