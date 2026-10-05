using System.Text.Json.Nodes;
using Nix.Features.Automations;

namespace Nix.Tests.Features.Automations;

/// <summary>
/// The whole-rule checks the three JSON readers cannot make alone: a name, which references make
/// sense for which trigger, and which refusal code a caller receives.
/// </summary>
public sealed class AutomationRuleValidatorTests
{
    private static readonly Guid Scope = Guid.Parse("0199a000-0000-7000-8000-0000000000c0");

    private static AutomationRuleInput Input(
        string trigger,
        string actions,
        string? conditions = null,
        Guid? scope = null,
        string name = "My rule") =>
        new(
            name,
            true,
            scope,
            JsonNode.Parse(trigger)!.AsObject(),
            conditions is null ? null : JsonNode.Parse(conditions)!.AsArray(),
            JsonNode.Parse(actions)!.AsArray());

    [Fact]
    public void A_property_rule_with_conditions_and_a_triggering_item_target_is_valid()
    {
        var result = AutomationRuleValidator.Validate(Input(
            """{"type":"property_changed","key":"status","to":{"value":"done"}}""",
            """[{"type":"set_property","target":"triggering_item","key":"done_on","value":"today"}]""",
            """[{"key":"priority","op":"equals","value":"high"}]"""));

        Assert.True(result.IsSuccess, result.IsFailure ? result.Error.Message : string.Empty);
        Assert.Equal("My rule", result.Value.Name);
        Assert.Single(result.Value.Conditions);
    }

    [Theory]
    [InlineData("")]
    [InlineData("   ")]
    public void A_blank_name_is_refused(string name)
    {
        var result = AutomationRuleValidator.Validate(Input(
            """{"type":"schedule","freq":"daily","interval":1,"time":"09:00"}""",
            """[{"type":"notify","title":"Hi"}]""",
            name: name));

        Assert.Equal(AutomationErrors.InvalidCode, result.Error.Code);
    }

    [Fact]
    public void Five_actions_that_each_fit_but_together_exceed_the_stored_bound_are_refused()
    {
        var value = new string('v', 4000);
        var action = $$"""{"type":"set_property","target":"triggering_item","key":"k","value":"{{value}}"}""";
        var result = AutomationRuleValidator.Validate(Input(
            """{"type":"property_changed","key":"status"}""",
            $"[{string.Join(',', Enumerable.Repeat(action, 5))}]"));

        Assert.True(result.IsFailure);
        Assert.Equal(AutomationErrors.InvalidCode, result.Error.Code);
        Assert.Contains("12 KiB", result.Error.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void Five_actions_inside_the_aggregate_bound_are_valid()
    {
        var value = new string('v', 2000);
        var action = $$"""{"type":"set_property","target":"triggering_item","key":"k","value":"{{value}}"}""";
        var result = AutomationRuleValidator.Validate(Input(
            """{"type":"property_changed","key":"status"}""",
            $"[{string.Join(',', Enumerable.Repeat(action, 5))}]"));

        Assert.True(result.IsSuccess, result.IsFailure ? result.Error.Message : string.Empty);
    }

    [Fact]
    public void A_name_over_200_characters_is_refused() =>
        Assert.True(AutomationRuleValidator.Validate(Input(
            """{"type":"schedule","freq":"daily","interval":1,"time":"09:00"}""",
            """[{"type":"notify","title":"Hi"}]""",
            name: new string('n', 201))).IsFailure);

    [Fact]
    public void A_schedule_rule_refuses_conditions()
    {
        var result = AutomationRuleValidator.Validate(Input(
            """{"type":"schedule","freq":"daily","interval":1,"time":"09:00"}""",
            """[{"type":"notify","title":"Hi"}]""",
            """[{"key":"status","op":"is_empty"}]"""));

        Assert.Equal(AutomationErrors.InvalidCode, result.Error.Code);
    }

    [Theory]
    [InlineData("""[{"type":"set_property","target":"triggering_item","key":"status","value":1}]""")]
    [InlineData("""[{"type":"create_item","parent":"triggering_item","itemType":"task","title":"x"}]""")]
    public void A_schedule_rule_has_no_triggering_item_to_act_on(string actions)
    {
        var result = AutomationRuleValidator.Validate(Input(
            """{"type":"schedule","freq":"daily","interval":1,"time":"09:00"}""", actions));

        Assert.Equal(AutomationErrors.InvalidCode, result.Error.Code);
    }

    [Fact]
    public void Creating_under_the_scope_needs_a_scope()
    {
        const string actions = """[{"type":"create_item","parent":"scope","itemType":"task","title":"x"}]""";
        const string trigger = """{"type":"schedule","freq":"daily","interval":1,"time":"09:00"}""";

        Assert.True(AutomationRuleValidator.Validate(Input(trigger, actions)).IsFailure);
        Assert.True(AutomationRuleValidator.Validate(Input(trigger, actions, scope: Scope)).IsSuccess);
    }

    [Fact]
    public void An_unavailable_action_is_reported_with_its_own_code()
    {
        var result = AutomationRuleValidator.Validate(Input(
            """{"type":"property_changed","key":"status"}""",
            """[{"type":"create_from_template","templateId":"0199a000-0000-7000-8000-0000000000c1"}]"""));

        Assert.Equal(AutomationErrors.ActionUnavailableCode, result.Error.Code);
    }

    [Fact]
    public void A_missing_trigger_or_action_list_is_refused()
    {
        var noTrigger = new AutomationRuleInput("r", true, null, null!, null, new JsonArray(new JsonObject { ["type"] = "notify", ["title"] = "x" }));
        var noActions = new AutomationRuleInput("r", true, null, new JsonObject { ["type"] = "property_changed", ["key"] = "k" }, null, null!);

        Assert.Equal(AutomationErrors.InvalidCode, AutomationRuleValidator.Validate(noTrigger).Error.Code);
        Assert.Equal(AutomationErrors.InvalidCode, AutomationRuleValidator.Validate(noActions).Error.Code);
    }

    [Fact]
    public void Every_violation_is_reported_at_once()
    {
        var result = AutomationRuleValidator.Validate(Input(
            """{"type":"schedule","freq":"daily","interval":0,"time":"09:00"}""",
            """[{"type":"notify","title":""}]"""));

        Assert.Contains("trigger", result.Error.Message, StringComparison.Ordinal);
        Assert.Contains("actions", result.Error.Message, StringComparison.Ordinal);
    }
}
