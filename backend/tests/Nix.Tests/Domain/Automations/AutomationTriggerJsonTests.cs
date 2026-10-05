using System.Text.Json.Nodes;
using Nix.Domain.Automations;
using Nix.Domain.Recurrence;

namespace Nix.Tests.Domain.Automations;

/// <summary>
/// The stored, versioned trigger shape (ADR-0051 section 6): strict, unknown fields refused, and
/// written back canonically so the database trigger and the planner read the same document.
/// </summary>
public sealed class AutomationTriggerJsonTests
{
    [Fact]
    public void A_schedule_trigger_reads_and_writes_back_canonically()
    {
        var parsed = AutomationTriggerJson.Read(JsonNode.Parse("""
            {"type":"schedule","freq":"weekly","interval":2,"weekdays":["mo","fr"],"time":"07:30",
             "timeZone":"Europe/London","startDate":"2026-10-05"}
            """));

        Assert.True(parsed.IsValid, string.Join(", ", parsed.Violations));
        var schedule = Assert.IsType<ScheduleTrigger>(parsed.Value);
        Assert.Equal(ScheduleFrequency.Weekly, schedule.Frequency);
        Assert.Equal(2, schedule.Interval);
        Assert.Equal([IsoDayOfWeek.Monday, IsoDayOfWeek.Friday], schedule.Weekdays.ToArray());
        Assert.Equal(new TimeOnly(7, 30), schedule.Time);
        Assert.Equal("Europe/London", schedule.TimeZone);
        Assert.Equal(new DateOnly(2026, 10, 5), schedule.StartDate);

        var written = AutomationTriggerJson.Write(schedule);
        Assert.Equal("schedule", written["type"]!.GetValue<string>());
        var reread = AutomationTriggerJson.Read(written);
        Assert.True(reread.IsValid);
        Assert.Equal(written.ToJsonString(), AutomationTriggerJson.Write(reread.Value!).ToJsonString());
    }

    [Fact]
    public void A_schedule_trigger_without_a_zone_follows_the_owner()
    {
        var parsed = AutomationTriggerJson.Read(JsonNode.Parse("""{"type":"schedule","freq":"daily","interval":1,"time":"09:00"}"""));

        Assert.True(parsed.IsValid);
        var schedule = Assert.IsType<ScheduleTrigger>(parsed.Value);
        Assert.Null(schedule.TimeZone);
        Assert.Null(schedule.StartDate);
        Assert.True(schedule.Weekdays.IsDefaultOrEmpty);
    }

    [Theory]
    [InlineData("""{"type":"schedule","freq":"daily","interval":1,"time":"09:00","extra":1}""")]
    [InlineData("""{"type":"schedule","freq":"hourly","interval":1,"time":"09:00"}""")]
    [InlineData("""{"type":"schedule","freq":"daily","interval":0,"time":"09:00"}""")]
    [InlineData("""{"type":"schedule","freq":"daily","interval":367,"time":"09:00"}""")]
    [InlineData("""{"type":"schedule","freq":"daily","interval":1,"time":"9am"}""")]
    [InlineData("""{"type":"schedule","freq":"daily","interval":1,"time":"09:00","weekdays":["mo"]}""")]
    [InlineData("""{"type":"schedule","freq":"weekly","interval":1,"time":"09:00","weekdays":["xx"]}""")]
    [InlineData("""{"type":"schedule","freq":"daily","interval":1,"time":"09:00","timeZone":"Mars/Olympus"}""")]
    [InlineData("""{"type":"schedule","freq":"daily","interval":1,"time":"09:00","startDate":"soon"}""")]
    [InlineData("""{"type":"date_arrives","key":"due_date","offsetMinutes":10081}""")]
    [InlineData("""{"type":"date_arrives","key":"due_date","offsetMinutes":-10081}""")]
    [InlineData("""{"type":"date_arrives","key":"$due_set_by","offsetMinutes":0}""")]
    [InlineData("""{"type":"date_arrives","key":"","offsetMinutes":0}""")]
    [InlineData("""{"type":"property_changed","key":"$habit_frequency"}""")]
    [InlineData("""{"type":"property_changed","key":"status","to":"done"}""")]
    [InlineData("""{"type":"property_changed","key":"status","to":{"value":"done","other":1}}""")]
    [InlineData("""{"type":"property_changed"}""")]
    [InlineData("""{"type":"webhook"}""")]
    [InlineData("""[]""")]
    public void A_malformed_trigger_is_refused(string json)
    {
        var parsed = AutomationTriggerJson.Read(JsonNode.Parse(json));

        Assert.False(parsed.IsValid);
        Assert.NotEmpty(parsed.Violations);
        Assert.Null(parsed.Value);
    }

    [Fact]
    public void A_key_longer_than_128_characters_is_refused()
    {
        var node = new JsonObject { ["type"] = "property_changed", ["key"] = new string('k', 129) };

        Assert.False(AutomationTriggerJson.Read(node).IsValid);
    }

    [Fact]
    public void A_date_trigger_defaults_its_time_to_nine()
    {
        var parsed = AutomationTriggerJson.Read(JsonNode.Parse("""{"type":"date_arrives","key":"due_date","offsetMinutes":-60}"""));

        var date = Assert.IsType<DateArrivesTrigger>(parsed.Value);
        Assert.Equal("due_date", date.Key);
        Assert.Equal(-60, date.OffsetMinutes);
        Assert.Equal(new TimeOnly(9, 0), date.Time);
    }

    [Fact]
    public void A_property_trigger_tells_an_absent_to_from_a_to_of_null()
    {
        var any = Assert.IsType<PropertyChangedTrigger>(AutomationTriggerJson.Read(JsonNode.Parse(
            """{"type":"property_changed","key":"status"}""")).Value);
        var cleared = Assert.IsType<PropertyChangedTrigger>(AutomationTriggerJson.Read(JsonNode.Parse(
            """{"type":"property_changed","key":"status","to":{"value":null}}""")).Value);

        Assert.Null(any.To);
        Assert.NotNull(cleared.To);
        Assert.Null(cleared.To!.Value);

        // Written back with the same distinction the database trigger reads: `trigger ? 'to'`.
        Assert.False(AutomationTriggerJson.Write(any).ContainsKey("to"));
        Assert.True(AutomationTriggerJson.Write(cleared).ContainsKey("to"));
    }

    [Fact]
    public void A_property_trigger_carries_from_and_to_values()
    {
        var parsed = AutomationTriggerJson.Read(JsonNode.Parse(
            """{"type":"property_changed","key":"status","from":{"value":"todo"},"to":{"value":"done"}}"""));

        var trigger = Assert.IsType<PropertyChangedTrigger>(parsed.Value);
        Assert.Equal("todo", trigger.From!.Value!.GetValue<string>());
        Assert.Equal("done", trigger.To!.Value!.GetValue<string>());
        Assert.Equal(AutomationTriggerType.PropertyChanged, trigger.Type);
    }
}
