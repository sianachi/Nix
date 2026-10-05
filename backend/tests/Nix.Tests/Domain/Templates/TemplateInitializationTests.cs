using System.Collections.Immutable;
using System.Text.Json.Nodes;
using Nix.Domain.Properties;
using Nix.Domain.Templates;

namespace Nix.Tests.Domain.Templates;

public sealed class TemplateInitializationTests
{
    private static readonly Guid Source = Guid.Parse("10000000-0000-4000-8000-000000000001");
    private static readonly Guid ExternalTarget = Guid.Parse("90000000-0000-4000-8000-000000000001");

    [Fact]
    public void Initialization_json_round_trips_string_vocabulary_and_external_reference_targets()
    {
        var initialization = Definition(
            [new TemplateInitializationInput("client", "Client", TemplateInitializationInputType.Text, true)],
            [new TemplateInitializationRule(Source, "name", TemplateInitializationRuleKind.Set, JsonValue.Create("{{client}}"))],
            [new TemplateReferenceRule(ExternalTarget, TemplateReferencePolicy.Omit)]);

        var json = TemplateInitializationJson.Write(initialization);

        Assert.Contains("\"type\":\"text\"", json, StringComparison.Ordinal);
        Assert.Contains("\"kind\":\"set\"", json, StringComparison.Ordinal);
        Assert.Contains("\"policy\":\"omit\"", json, StringComparison.Ordinal);
        Assert.True(TemplateInitializationJson.TryRead(json, out var restored, out var refusal), refusal);
        Assert.Null(TemplateInitializationValidator.Validate(restored, new HashSet<Guid> { Source }));
        Assert.Equal(ExternalTarget, Assert.Single(restored.References).SourceItemId);
    }

    [Fact]
    public void Initialization_json_omits_absent_optional_fields_for_strict_client_schemas()
    {
        var initialization = Definition(
            [new TemplateInitializationInput("client", "Client", TemplateInitializationInputType.Text, true)],
            [new TemplateInitializationRule(Source, "name", TemplateInitializationRuleKind.Keep)],
            [new TemplateReferenceRule(ExternalTarget, TemplateReferencePolicy.Omit)]);

        var json = TemplateInitializationJson.Write(initialization);

        Assert.DoesNotContain("defaultValue", json, StringComparison.Ordinal);
        Assert.DoesNotContain("\"value\"", json, StringComparison.Ordinal);
        Assert.DoesNotContain("inputKey", json, StringComparison.Ordinal);
        Assert.DoesNotContain("offsetDays", json, StringComparison.Ordinal);
        Assert.DoesNotContain("timeOfDay", json, StringComparison.Ordinal);
        Assert.DoesNotContain("timeZone", json, StringComparison.Ordinal);
        Assert.True(TemplateInitializationJson.TryRead(json, out _, out var refusal), refusal);
    }

    [Fact]
    public void Client_canonical_initialization_fixture_round_trips_through_the_backend_serializer()
    {
        var fixturePath = Path.Combine(RepositoryRoot(), "fixtures", "template-initialization-v1.json");
        var fixture = File.ReadAllText(fixturePath);

        Assert.True(TemplateInitializationJson.TryRead(fixture, out var parsed, out var refusal), refusal);
        var sourceIds = parsed.Rules.Select(rule => rule.SourceId).ToHashSet();
        Assert.Null(TemplateInitializationValidator.Validate(parsed, sourceIds));
        var roundTrip = TemplateInitializationJson.Write(parsed);

        Assert.True(JsonNode.DeepEquals(JsonNode.Parse(fixture), JsonNode.Parse(roundTrip)));
    }

    [Theory]
    [InlineData("{\"version\":1,\"inputs\":null,\"rules\":[],\"references\":[]}")]
    [InlineData("{\"version\":1,\"inputs\":[],\"rules\":[]}")]
    [InlineData("{\"version\":1,\"inputs\":[{\"key\":\"name\",\"label\":\"Name\",\"type\":0,\"required\":true}],\"rules\":[],\"references\":[]}")]
    [InlineData("{\"version\":1,\"inputs\":[],\"rules\":[],\"references\":[],\"unknown\":true}")]
    [InlineData("{\"version\":1,\"inputs\":[{\"key\":\"name\",\"label\":\"Name\",\"type\":\"text\",\"required\":true,\"defaultValue\":null}],\"rules\":[],\"references\":[]}")]
    [InlineData("{\"version\":1,\"inputs\":[],\"rules\":[{\"sourceId\":\"10000000-0000-4000-8000-000000000001\",\"propertyKey\":\"done\",\"kind\":\"clear\",\"inputKey\":null}],\"references\":[]}")]
    public void Initialization_json_rejects_null_missing_numeric_and_unknown_shape(string json)
    {
        Assert.False(TemplateInitializationJson.TryRead(json, out _, out var refusal));
        Assert.NotNull(refusal);
    }

    [Fact]
    public void Initialization_json_rejects_a_definition_over_the_byte_limit_before_deserializing()
    {
        var json = "{" + new string(' ', TemplateInitializationJson.MaximumBytes) + "}";

        Assert.False(TemplateInitializationJson.TryRead(json, out _, out var refusal));
        Assert.Contains("exceeds", refusal, StringComparison.Ordinal);
    }

    [Fact]
    public void Definition_rejects_duplicate_keys_and_rules_with_unknown_inputs()
    {
        var duplicate = Definition(
            [
                new TemplateInitializationInput("client", "Client", TemplateInitializationInputType.Text, false),
                new TemplateInitializationInput("client", "Client again", TemplateInitializationInputType.Text, false),
            ],
            [],
            []);
        var unknownInput = Definition(
            [],
            [new TemplateInitializationRule(Source, "name", TemplateInitializationRuleKind.Input, InputKey: "missing")],
            []);

        Assert.Contains("duplicated", TemplateInitializationValidator.Validate(duplicate, new HashSet<Guid> { Source }), StringComparison.Ordinal);
        Assert.Contains("declared input", TemplateInitializationValidator.Validate(unknownInput, new HashSet<Guid> { Source }), StringComparison.Ordinal);
    }

    [Fact]
    public void Reference_rules_are_keyed_by_external_target_not_template_source()
    {
        var initialization = Definition(
            [new TemplateInitializationInput("replacement", "Replace with", TemplateInitializationInputType.Item, true)],
            [],
            [new TemplateReferenceRule(ExternalTarget, TemplateReferencePolicy.Replace, "replacement")]);

        Assert.Null(TemplateInitializationValidator.Validate(initialization, new HashSet<Guid> { Source }));
    }

    [Fact]
    public void Inputs_apply_defaults_reject_unknowns_and_build_display_safe_bindings()
    {
        var memberId = "AB000000-0000-4000-8000-000000000002";
        var definition = Definition(
            [
                new TemplateInitializationInput("client", "Client", TemplateInitializationInputType.Text, true, "Northwind"),
                new TemplateInitializationInput("owner", "Owner", TemplateInitializationInputType.Member, true),
                new TemplateInitializationInput("launch", "Launch date", TemplateInitializationInputType.Date, true),
            ],
            [],
            []);

        Assert.True(TemplateInitializationValidator.TryResolveInputs(
            definition,
            new Dictionary<string, string> { ["owner"] = memberId, ["launch"] = "2026-05-20" },
            new Dictionary<string, string> { ["owner"] = "Ada Lovelace" },
            out var resolved,
            out var refusal), refusal);
        Assert.Equal("Northwind", resolved.Values["client"]);
        Assert.Equal("Northwind", resolved.TextBindings["client"]);
        Assert.Equal(Guid.Parse(memberId).ToString("D"), resolved.Values["owner"]);
        Assert.Equal("Ada Lovelace", resolved.TextBindings["owner"]);
        Assert.Equal("2026-05-20", resolved.TextBindings["launch"]);

        Assert.False(TemplateInitializationValidator.TryResolveInputs(
            definition,
            new Dictionary<string, string> { ["extra"] = "ignored" },
            null,
            out _,
            out refusal));
        Assert.Contains("not declared", refusal, StringComparison.Ordinal);
    }

    [Theory]
    [InlineData("2026-02-30")]
    [InlineData("2026-5-02")]
    [InlineData("tomorrow")]
    public void Date_inputs_require_exact_calendar_days(string value)
    {
        var input = new TemplateInitializationInput("date", "Date", TemplateInitializationInputType.Date, true);

        Assert.NotNull(TemplateInitializationValidator.ValidateInputValue(input, value));
    }

    [Fact]
    public void Evaluator_resets_task_state_applies_rules_binds_titles_and_clears_recurrence_completion()
    {
        var schema = new PropertySchema
        {
            Inherit = false,
            Properties =
            [
                new PropertyDefinition("done", "Done", PropertyType.Completion, [], true),
                new PropertyDefinition("assignee", "Assignee", PropertyType.Assignee, [], false),
                new PropertyDefinition("due_date", "Due date", PropertyType.DueDate, [], false),
                new PropertyDefinition("start_date", "Start date", PropertyType.StartDate, [], false),
                new PropertyDefinition("client", "Client", PropertyType.Text, [], true),
            ],
        };
        var recurrence = """
            {"freq":"daily","interval":2,"until":"2026-05-01","completedThrough":"2026-03-20","completed":["2026-04-01"]}
            """;
        var item = new TemplateInitializationItem(
            Source,
            "{{client}} kickoff",
            """{"done":true,"assignee":"ab000000-0000-4000-8000-000000000002","due_date":"2026-04-01","start_date":"2026-04-02","client":"Old client"}""",
            recurrence);
        var definition = Definition(
            [
                new TemplateInitializationInput("client", "Client", TemplateInitializationInputType.Text, true),
                new TemplateInitializationInput("launch", "Launch", TemplateInitializationInputType.Date, true),
            ],
            [
                new TemplateInitializationRule(Source, "client", TemplateInitializationRuleKind.Input, InputKey: "client"),
                new TemplateInitializationRule(Source, "start_date", TemplateInitializationRuleKind.Input, InputKey: "launch"),
                new TemplateInitializationRule(Source, "due_date", TemplateInitializationRuleKind.RelativeDate, InputKey: "launch", OffsetDays: 3),
                new TemplateInitializationRule(Source, TemplateInitializationRule.RecurrenceUntilPropertyKey, TemplateInitializationRuleKind.RelativeDate, InputKey: "launch", OffsetDays: 30),
            ],
            [new TemplateReferenceRule(ExternalTarget, TemplateReferencePolicy.Omit)]);
        Assert.True(TemplateInitializationValidator.TryResolveInputs(
            definition,
            new Dictionary<string, string> { ["client"] = "Apollo", ["launch"] = "2026-04-03" },
            null,
            out var inputs,
            out var refusal), refusal);

        Assert.True(TemplateInitializationEvaluator.TryEvaluate(
            definition,
            [item],
            inputs,
            new Dictionary<Guid, PropertySchema> { [Source] = schema },
            out var result,
            out refusal), refusal);

        var initialized = Assert.Single(result.Items);
        Assert.Equal("Apollo kickoff", initialized.Title);
        var properties = JsonNode.Parse(initialized.Properties!)!.AsObject();
        Assert.False(properties["done"]!.GetValue<bool>());
        Assert.Null(properties["assignee"]);
        Assert.Equal("2026-04-06", properties["due_date"]!.GetValue<string>());
        Assert.Equal("2026-04-03", properties["start_date"]!.GetValue<string>());
        Assert.Equal("Apollo", properties["client"]!.GetValue<string>());
        Assert.Equal("Apollo", result.TextBindings["client"]);
        Assert.Equal(ExternalTarget, Assert.Single(result.References).SourceItemId);
        var resetRule = Nix.Domain.Recurrence.RecurrenceRuleJson.Read(initialized.Recurrence);
        Assert.NotNull(resetRule);
        Assert.Equal(2, resetRule.Interval);
        Assert.Equal(new DateOnly(2026, 5, 3), resetRule.Until);
        Assert.Null(resetRule.CompletedThrough);
        Assert.Empty(resetRule.Completed);
    }

    [Fact]
    public void Evaluator_requires_missing_required_properties_to_be_initialized()
    {
        var schema = new PropertySchema
        {
            Inherit = false,
            Properties = [new PropertyDefinition("client", "Client", PropertyType.Text, [], true)],
        };

        Assert.False(TemplateInitializationEvaluator.TryEvaluate(
            TemplateInitialization.Empty,
            [new TemplateInitializationItem(Source, "Project", null, null)],
            ResolvedInputs(),
            new Dictionary<Guid, PropertySchema> { [Source] = schema },
            out _,
            out var refusal));
        Assert.Contains("required property", refusal, StringComparison.Ordinal);
    }

    [Theory]
    [InlineData("{\"client\":\"\"}")]
    [InlineData("{\"client\":\"   \"}")]
    public void Evaluator_rejects_empty_required_text(string properties)
    {
        var schema = new PropertySchema
        {
            Inherit = false,
            Properties = [new PropertyDefinition("client", "Client", PropertyType.Text, [], true)],
        };

        Assert.False(TemplateInitializationEvaluator.TryEvaluate(
            TemplateInitialization.Empty,
            [new TemplateInitializationItem(Source, "Project", properties, null)],
            ResolvedInputs(),
            new Dictionary<Guid, PropertySchema> { [Source] = schema },
            out _,
            out var refusal));
        Assert.Contains("required property", refusal, StringComparison.Ordinal);
    }

    [Fact]
    public void Evaluator_rejects_an_empty_required_collection()
    {
        var schema = new PropertySchema
        {
            Inherit = false,
            Properties = [new PropertyDefinition("labels", "Labels", PropertyType.MultiSelect, ["A"], true)],
        };

        Assert.False(TemplateInitializationEvaluator.TryEvaluate(
            TemplateInitialization.Empty,
            [new TemplateInitializationItem(Source, "Project", "{\"labels\":[]}", null)],
            ResolvedInputs(),
            new Dictionary<Guid, PropertySchema> { [Source] = schema },
            out _,
            out var refusal));
        Assert.Contains("required property", refusal, StringComparison.Ordinal);
    }

    [Fact]
    public void Text_input_cannot_write_an_assignee_identifier()
    {
        var schema = new PropertySchema
        {
            Inherit = false,
            Properties = [new PropertyDefinition("assignee", "Assignee", PropertyType.Assignee, [], false)],
        };
        var definition = Definition(
            [new TemplateInitializationInput("owner", "Owner", TemplateInitializationInputType.Text, true)],
            [new TemplateInitializationRule(Source, "assignee", TemplateInitializationRuleKind.Input, InputKey: "owner")],
            []);
        Assert.True(TemplateInitializationValidator.TryResolveInputs(
            definition,
            new Dictionary<string, string> { ["owner"] = "3fa85f64-5717-4562-b3fc-2c963f66afa6" },
            new Dictionary<string, string>(),
            out var inputs,
            out var inputRefusal), inputRefusal);

        Assert.False(TemplateInitializationEvaluator.TryEvaluate(
            definition,
            [new TemplateInitializationItem(Source, "Project", null, null)],
            inputs,
            new Dictionary<Guid, PropertySchema> { [Source] = schema },
            out _,
            out var refusal));
        Assert.Contains("incompatible", refusal, StringComparison.Ordinal);
    }

    [Theory]
    [InlineData("Project_Name")]
    [InlineData("Project")]
    public void Input_keys_must_be_lowercase(string key)
    {
        Assert.False(TemplateInitializationValidator.IsKey(key));
    }

    [Fact]
    public void Evaluator_refuses_a_recurrence_until_before_the_new_anchor_but_accepts_an_explicit_clear()
    {
        var schema = new PropertySchema
        {
            Inherit = false,
            Properties = [new PropertyDefinition("due_date", "Due date", PropertyType.DueDate, [], false)],
        };
        var item = new TemplateInitializationItem(
            Source,
            "Task",
            """{"due_date":"2026-04-01"}""",
            """{"freq":"daily","interval":1,"until":"2026-04-05"}""");
        var dueRule = new TemplateInitializationRule(Source, "due_date", TemplateInitializationRuleKind.Set, JsonValue.Create("2026-04-10"));
        var noUntilRule = Definition([], [dueRule], []);
        var clearUntilRule = Definition(
            [],
            [dueRule, new TemplateInitializationRule(Source, TemplateInitializationRule.RecurrenceUntilPropertyKey, TemplateInitializationRuleKind.Clear)],
            []);

        Assert.True(TemplateInitializationEvaluator.TryEvaluate(
            noUntilRule,
            [item],
            ResolvedInputs(),
            new Dictionary<Guid, PropertySchema> { [Source] = schema },
            out _,
            out var refusal) is false);
        Assert.Contains("ends before", refusal, StringComparison.Ordinal);

        Assert.True(TemplateInitializationEvaluator.TryEvaluate(
            clearUntilRule,
            [item],
            ResolvedInputs(),
            new Dictionary<Guid, PropertySchema> { [Source] = schema },
            out var result,
            out refusal), refusal);
        Assert.Null(Nix.Domain.Recurrence.RecurrenceRuleJson.Read(Assert.Single(result.Items).Recurrence)!.Until);
    }

    [Theory]
    [InlineData("2026-03-29", "01:30", "gap")]
    [InlineData("2026-10-25", "01:30", "ambiguous")]
    public void Relative_timestamps_reject_daylight_saving_gaps_and_ambiguous_local_times(
        string date,
        string time,
        string expectedReason)
    {
        var schema = new PropertySchema
        {
            Inherit = false,
            Properties = [new PropertyDefinition("meeting", "Meeting", PropertyType.Timestamp, [], false)],
        };
        var definition = Definition(
            [new TemplateInitializationInput("day", "Day", TemplateInitializationInputType.Date, true)],
            [new TemplateInitializationRule(
                Source,
                "meeting",
                TemplateInitializationRuleKind.RelativeDate,
                InputKey: "day",
                OffsetDays: 0,
                TimeOfDay: time,
                TimeZone: "Europe/London")],
            []);
        Assert.True(TemplateInitializationValidator.TryResolveInputs(
            definition,
            new Dictionary<string, string> { ["day"] = date },
            null,
            out var inputs,
            out var refusal), refusal);

        Assert.False(TemplateInitializationEvaluator.TryEvaluate(
            definition,
            [new TemplateInitializationItem(Source, "Meeting", null, null)],
            inputs,
            new Dictionary<Guid, PropertySchema> { [Source] = schema },
            out _,
            out refusal));
        Assert.Contains(expectedReason, refusal, StringComparison.OrdinalIgnoreCase);
    }

    private static TemplateInitialization Definition(
        IReadOnlyList<TemplateInitializationInput> inputs,
        IReadOnlyList<TemplateInitializationRule> rules,
        IReadOnlyList<TemplateReferenceRule> references) =>
        new(1, inputs, rules, references);

    private static TemplateResolvedInputs ResolvedInputs() => new(
        ImmutableDictionary<string, string>.Empty.WithComparers(StringComparer.Ordinal),
        ImmutableDictionary<string, string>.Empty.WithComparers(StringComparer.Ordinal));

    private static string RepositoryRoot()
    {
        for (var directory = new DirectoryInfo(AppContext.BaseDirectory); directory is not null; directory = directory.Parent)
        {
            if (File.Exists(Path.Combine(directory.FullName, "AGENTS.md"))
                && Directory.Exists(Path.Combine(directory.FullName, "backend")))
            {
                return directory.FullName;
            }
        }

        throw new DirectoryNotFoundException("Could not locate the repository root for template initialization fixtures.");
    }
}
