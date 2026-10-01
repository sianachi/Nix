using Nix.Domain.Automations;

namespace Nix.Tests.Domain.Automations;

/// <summary>Title and body templates: two placeholders, plain text, truncated to the field's bound.</summary>
public sealed class AutomationTitleTemplateTests
{
    private static readonly DateOnly Today = new(2026, 10, 5);

    [Fact]
    public void Both_placeholders_are_substituted()
    {
        var rendered = AutomationTitleTemplate.Render("Review {item.title} on {date}", Today, "Quarterly plan", 500);

        Assert.Equal("Review Quarterly plan on 2026-10-05", rendered);
    }

    [Fact]
    public void Item_title_is_empty_without_a_triggering_item()
    {
        Assert.Equal("Daily note  2026-10-05", AutomationTitleTemplate.Render("Daily note {item.title} {date}", Today, null, 500));
    }

    [Fact]
    public void Other_braces_stay_literal_and_are_not_re_expanded()
    {
        var rendered = AutomationTitleTemplate.Render("{unknown} {item.title}", Today, "{date}", 500);

        Assert.Equal("{unknown} {date}", rendered);
    }

    [Fact]
    public void The_result_is_truncated_to_the_bound()
    {
        var rendered = AutomationTitleTemplate.Render("{item.title}", Today, new string('x', 300), 200);

        Assert.Equal(200, rendered.Length);
    }

    [Fact]
    public void Control_characters_from_an_item_title_are_removed()
    {
        Assert.Equal("ab", AutomationTitleTemplate.Render("{item.title}", Today, "a\u0000\nb", 200));
    }
}
