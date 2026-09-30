using Nix.Domain.Automations;

namespace Nix.Tests.Domain.Automations;

/// <summary>
/// Automation dedupe and trigger keys: identifiers only (ADR-0051 Amendment 1), at most 200
/// characters, and parsed back exactly - the executor reads the occurrence and depth from them.
/// </summary>
public sealed class AutomationDedupeKeysTests
{
    private static readonly Guid Rule = Guid.Parse("0199a000-0000-7000-8000-00000000000a");
    private static readonly Guid Item = Guid.Parse("0199a000-0000-7000-8000-00000000000b");

    [Fact]
    public void A_schedule_key_names_the_rule_and_the_local_day()
    {
        var key = AutomationDedupeKeys.Schedule(Rule, new DateOnly(2026, 10, 5));

        Assert.Equal($"auto:{Rule:D}:s:2026-10-05", key);
        Assert.True(AutomationDedupeKeys.TryParse(key, out var parsed));
        Assert.Equal(AutomationKeyKind.Schedule, parsed.Kind);
        Assert.Equal(Rule, parsed.RuleId);
        Assert.Equal(new DateOnly(2026, 10, 5), parsed.Day);
        Assert.Equal(0, parsed.Depth);
    }

    [Fact]
    public void A_date_key_names_the_rule_the_item_and_the_exact_instant()
    {
        var instant = new DateTimeOffset(2026, 10, 5, 8, 0, 0, TimeSpan.FromHours(1));

        var key = AutomationDedupeKeys.Date(Rule, Item, instant);

        Assert.True(AutomationDedupeKeys.TryParse(key, out var parsed));
        Assert.Equal(AutomationKeyKind.Date, parsed.Kind);
        Assert.Equal(Item, parsed.ItemId);
        Assert.Equal(instant, parsed.Instant);
        Assert.Equal(TimeSpan.Zero, parsed.Instant!.Value.Offset);
        Assert.True(key.Length <= AutomationDedupeKeys.MaximumLength);
    }

    [Fact]
    public void A_property_key_carries_the_chain_depth_the_database_trigger_wrote()
    {
        // Built by nix_enqueue_automation_property_changes in SQL; the C# builder exists so tests
        // and the parser agree on one spelling.
        var key = AutomationDedupeKeys.Property(Rule, 1, Item, new DateTimeOffset(2026, 10, 5, 8, 7, 59, TimeSpan.Zero));

        Assert.Equal($"auto:{Rule:D}:p1:{Item:D}:202610050807", key);
        Assert.True(AutomationDedupeKeys.TryParse(key, out var parsed));
        Assert.Equal(AutomationKeyKind.Property, parsed.Kind);
        Assert.Equal(1, parsed.Depth);
        Assert.Equal(Item, parsed.ItemId);
    }

    [Fact]
    public void A_manual_key_is_unique_per_run()
    {
        var first = AutomationDedupeKeys.Manual();
        var second = AutomationDedupeKeys.Manual();

        Assert.NotEqual(first, second);
        Assert.True(AutomationDedupeKeys.TryParse(first, out var parsed));
        Assert.Equal(AutomationKeyKind.Manual, parsed.Kind);
    }

    [Theory]
    [InlineData("")]
    [InlineData("due:0199a000-0000-7000-8000-00000000000b:2026-10-05")]
    [InlineData("auto:not-a-guid:s:2026-10-05")]
    [InlineData("auto:0199a000-0000-7000-8000-00000000000a:s:2026-13-05")]
    [InlineData("auto:0199a000-0000-7000-8000-00000000000a:p:0199a000-0000-7000-8000-00000000000b:202610050807")]
    [InlineData("auto:0199a000-0000-7000-8000-00000000000a:p-1:0199a000-0000-7000-8000-00000000000b:202610050807")]
    [InlineData("auto:0199a000-0000-7000-8000-00000000000a:d:0199a000-0000-7000-8000-00000000000b:tomorrow")]
    [InlineData("auto:0199a000-0000-7000-8000-00000000000a:x:2026-10-05")]
    [InlineData("manual:nope")]
    public void A_foreign_or_malformed_key_does_not_parse(string key) =>
        Assert.False(AutomationDedupeKeys.TryParse(key, out _));
}
