using System.Collections.Immutable;
using System.Text.Json.Nodes;
using Nix.Domain.Views;
using Nix.Features.Views;

namespace Nix.Tests.Features.Views;

public sealed class PublicFormRulesTests
{
    [Fact]
    public void Hidden_required_fields_are_not_required_or_used_by_later_conditions()
    {
        var form = Form([
            Field("show", required: false),
            Field("hidden", required: true, [new FormCondition("show", "equals", "yes")]),
            Field("later", required: false, [new FormCondition("hidden", "equals", "secret")]),
        ]);
        var answers = new Dictionary<string, JsonNode?>(StringComparer.Ordinal)
        {
            ["show"] = "no",
            ["hidden"] = "secret",
        };

        var visible = PublicFormEndpoints.VisibleFields(form, answers);

        Assert.Equal(["show"], visible.Select(block => block.Id));
    }

    [Fact]
    public void A_non_boolean_checkbox_condition_is_safely_treated_as_not_matching()
    {
        var form = Form([
            Field("choice", required: false),
            Field("follow-up", required: false, [new FormCondition("choice", "checked", null)]),
        ]);
        var answers = new Dictionary<string, JsonNode?>(StringComparer.Ordinal) { ["choice"] = "yes" };

        var visible = PublicFormEndpoints.VisibleFields(form, answers);

        Assert.Equal(["choice"], visible.Select(block => block.Id));
    }

    [Fact]
    public void Response_titles_use_the_selected_answer_or_a_stable_generated_fallback()
    {
        var selectedForm = Form([Field("name", required: false)]) with
        {
            TitleMode = "field",
            TitleFieldBlockId = "name",
        };
        var submittedAt = new DateTimeOffset(2026, 8, 16, 17, 4, 5, TimeSpan.Zero);

        Assert.Equal(
            "Ada",
            PublicFormEndpoints.GenerateResponseTitle(
                selectedForm,
                "Daily tracker",
                new Dictionary<string, JsonNode?> { ["name"] = " Ada " },
                submittedAt));
        Assert.Equal(
            "Daily tracker — 2026-08-16 17:04:05 UTC",
            PublicFormEndpoints.GenerateResponseTitle(
                selectedForm,
                "Daily tracker",
                new Dictionary<string, JsonNode?>(),
                submittedAt));
    }

    private static InteractiveFormDefinition Form(ImmutableArray<FormBlock> blocks) =>
        new([new FormPage("page", "Page", null, [], blocks)], "generated", null, "Done", "Thanks");

    private static FormBlock Field(
        string id,
        bool required,
        ImmutableArray<FormCondition> conditions = default) =>
        new(id, "field", id, id, null, required, null, conditions.IsDefault ? [] : conditions);
}
