using System.Text.Json.Nodes;
using Nix.Domain.Automations;

namespace Nix.Tests.Domain.Automations;

/// <summary>When a date_arrives rule fires for one item's stored value.</summary>
public sealed class AutomationDateInstantTests
{
    [Fact]
    public void A_date_only_value_fires_at_the_rule_time_in_the_owner_zone()
    {
        var at = AutomationDateInstant.Resolve(JsonValue.Create("2026-10-05"), new TimeOnly(9, 0), 0, "Europe/London");

        Assert.Equal(new DateTimeOffset(2026, 10, 5, 8, 0, 0, TimeSpan.Zero), at);
    }

    [Fact]
    public void An_offset_moves_the_instant_earlier_or_later()
    {
        var before = AutomationDateInstant.Resolve(JsonValue.Create("2026-10-05"), new TimeOnly(9, 0), -60, "Etc/UTC");
        var after = AutomationDateInstant.Resolve(JsonValue.Create("2026-10-05"), new TimeOnly(9, 0), 1440, "Etc/UTC");

        Assert.Equal(new DateTimeOffset(2026, 10, 5, 8, 0, 0, TimeSpan.Zero), before);
        Assert.Equal(new DateTimeOffset(2026, 10, 6, 9, 0, 0, TimeSpan.Zero), after);
    }

    [Fact]
    public void A_timestamp_value_fires_at_its_own_instant_ignoring_the_rule_time()
    {
        var at = AutomationDateInstant.Resolve(
            JsonValue.Create("2026-10-05T14:30:00+01:00[Europe/London]"), new TimeOnly(9, 0), -30, "Asia/Tokyo");

        Assert.Equal(new DateTimeOffset(2026, 10, 5, 13, 0, 0, TimeSpan.Zero), at);
    }

    [Theory]
    [InlineData("soon")]
    [InlineData("")]
    [InlineData("2026-02-30")]
    public void A_value_that_is_not_a_date_never_fires(string text) =>
        Assert.Null(AutomationDateInstant.Resolve(JsonValue.Create(text), new TimeOnly(9, 0), 0, "Etc/UTC"));

    [Fact]
    public void A_missing_or_non_text_value_never_fires()
    {
        Assert.Null(AutomationDateInstant.Resolve(null, new TimeOnly(9, 0), 0, "Etc/UTC"));
        Assert.Null(AutomationDateInstant.Resolve(JsonValue.Create(20261005), new TimeOnly(9, 0), 0, "Etc/UTC"));
    }
}
