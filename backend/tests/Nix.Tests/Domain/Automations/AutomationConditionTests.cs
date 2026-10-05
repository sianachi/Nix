using System.Text.Json.Nodes;
using Nix.Domain.Automations;

namespace Nix.Tests.Domain.Automations;

/// <summary>Conditions on the triggering item: at most five, four operators, evaluated on current values.</summary>
public sealed class AutomationConditionTests
{
    [Fact]
    public void Conditions_read_and_write_back()
    {
        var parsed = AutomationConditionJson.ReadAll(JsonNode.Parse("""
            [{"key":"status","op":"equals","value":"done"},{"key":"owner","op":"is_empty"}]
            """));

        Assert.True(parsed.IsValid, string.Join(", ", parsed.Violations));
        Assert.Equal(2, parsed.Value.Length);
        Assert.Equal(AutomationConditionOperator.IsEmpty, parsed.Value[1].Operator);
        var reread = AutomationConditionJson.ReadAll(AutomationConditionJson.WriteAll(parsed.Value));
        Assert.True(reread.IsValid);
        Assert.Equal(2, reread.Value.Length);
    }

    [Fact]
    public void Absent_conditions_are_an_empty_list()
    {
        var parsed = AutomationConditionJson.ReadAll(null);

        Assert.True(parsed.IsValid);
        Assert.Empty(parsed.Value);
    }

    [Theory]
    [InlineData("""[{"key":"status","op":"equals"}]""")]
    [InlineData("""[{"key":"status","op":"is_empty","value":"x"}]""")]
    [InlineData("""[{"key":"status","op":"contains","value":"x"}]""")]
    [InlineData("""[{"key":"$due_set_by","op":"is_empty"}]""")]
    [InlineData("""[{"key":"status","op":"is_empty","extra":1}]""")]
    [InlineData("""[{"key":"a","op":"is_empty"},{"key":"b","op":"is_empty"},{"key":"c","op":"is_empty"},{"key":"d","op":"is_empty"},{"key":"e","op":"is_empty"},{"key":"f","op":"is_empty"}]""")]
    [InlineData("""{"key":"status","op":"is_empty"}""")]
    public void A_malformed_condition_list_is_refused(string json) =>
        Assert.False(AutomationConditionJson.ReadAll(JsonNode.Parse(json)).IsValid);

    [Fact]
    public void Operators_evaluate_against_the_current_bag()
    {
        var bag = JsonNode.Parse("""{"status":"done","tags":[],"note":"","count":3}""")!.AsObject();

        Assert.True(Condition("status", AutomationConditionOperator.EqualTo, JsonValue.Create("done")).IsMet(bag));
        Assert.False(Condition("status", AutomationConditionOperator.NotEqualTo, JsonValue.Create("done")).IsMet(bag));
        Assert.True(Condition("count", AutomationConditionOperator.EqualTo, JsonValue.Create(3)).IsMet(bag));
        Assert.True(Condition("missing", AutomationConditionOperator.IsEmpty, null).IsMet(bag));
        Assert.True(Condition("tags", AutomationConditionOperator.IsEmpty, null).IsMet(bag));
        Assert.True(Condition("note", AutomationConditionOperator.IsEmpty, null).IsMet(bag));
        Assert.True(Condition("status", AutomationConditionOperator.IsNotEmpty, null).IsMet(bag));
        Assert.True(Condition("missing", AutomationConditionOperator.NotEqualTo, JsonValue.Create("x")).IsMet(bag));
    }

    private static AutomationCondition Condition(string key, AutomationConditionOperator op, JsonNode? value) => new(key, op, value);
}
