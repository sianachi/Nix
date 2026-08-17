using System.Text.Json;
using System.Text.Json.Nodes;
using Nix.Domain.Templates;
using Nix.Features.Templates;
using Nix.Tests.Harness;

namespace Nix.Tests.Features.Templates;

public sealed class TemplateImportContractTests
{
    private static readonly JsonSerializerOptions WebJson = new(JsonSerializerDefaults.Web);

    [Theory]
    [InlineData("-9223372036854775808", long.MinValue)]
    [InlineData("0", 0L)]
    [InlineData("9223372036854775807", long.MaxValue)]
    public void The_full_int64_sequence_range_is_lossless(string text, long expected)
    {
        Assert.True(TemplateSequence.TryParse(text, out var sequence));
        Assert.Equal(expected, sequence);
    }

    [Theory]
    [InlineData("")]
    [InlineData("1.0")]
    [InlineData("9223372036854775808")]
    [InlineData("-9223372036854775809")]
    [InlineData("not-a-sequence")]
    public void Malformed_or_overflowing_sequences_are_refused(string text)
    {
        Assert.False(TemplateSequence.TryParse(text, out _));
    }

    [Fact]
    public void The_exact_collaboration_payload_binds_sequence_as_a_decimal_string()
    {
        const string json = """
            {
              "sourceId":"71111111-1111-4111-8111-111111111111",
              "parentSourceId":null,
              "itemType":"note",
              "title":"Portable",
              "seq":"9223372036854775807",
              "properties":null,
              "schema":null,
              "views":null,
              "hasBody":false
            }
            """;

        var item = JsonSerializer.Deserialize<ImportTemplateItemRequest>(json, WebJson);

        Assert.NotNull(item);
        Assert.Equal("9223372036854775807", item.Seq);
        Assert.True(TemplateSequence.TryParse(item.Seq, out var sequence));
        Assert.Equal(long.MaxValue, sequence);
    }

    [Fact]
    public async Task The_published_template_snapshot_has_named_lossless_contracts()
    {
        var json = await File.ReadAllTextAsync(
            PublishedContract.Path(),
            TestContext.Current.CancellationToken);
        var schemas = JsonNode.Parse(json)?["components"]?["schemas"]?.AsObject()
            ?? throw new InvalidOperationException("The published OpenAPI document has no schemas.");

        var item = schemas["TemplateItemResponse"]?["properties"]?.AsObject()
            ?? throw new InvalidOperationException("The template item contract is missing.");
        Assert.Equal(
            "#/components/schemas/TemplatePropertySchemaResponse",
            item["schema"]?["oneOf"]?[1]?["$ref"]?.GetValue<string>());
        Assert.Equal(
            "#/components/schemas/TemplateStoredViewsResponse",
            item["views"]?["oneOf"]?[1]?["$ref"]?.GetValue<string>());

        AssertRequired(
            schemas,
            "TemplatePropertySchemaResponse",
            "properties",
            "declared",
            "inherit");
        AssertRequired(
            schemas,
            "TemplateViewResponse",
            "id",
            "name",
            "kind",
            "columns",
            "groupBy",
            "groupOrder",
            "dateProperty",
            "sortBy",
            "sortDescending",
            "mode",
            "coverProperty",
            "endDateProperty",
            "cardSize",
            "filters",
            "companionViewId",
            "companionPlacement",
            "interactiveForm");
        AssertRequired(
            schemas,
            "TemplateInteractiveFormResponse",
            "pages",
            "titleMode",
            "titleFieldBlockId",
            "confirmationTitle",
            "confirmationMessage");

        Assert.Equal(
            ["seed", "user", "managed"],
            schemas["TemplateOriginResponse"]?["enum"]?.AsArray()
                .Select(value => value!.GetValue<string>()));
        Assert.Equal(
            ["merge", "create"],
            schemas["TemplateApplicationModeResponse"]?["enum"]?.AsArray()
                .Select(value => value!.GetValue<string>()));
    }

    private static void AssertRequired(
        JsonObject schemas,
        string name,
        params string[] expected)
    {
        var required = schemas[name]?["required"]?.AsArray()
            .Select(value => value!.GetValue<string>())
            .ToArray()
            ?? throw new InvalidOperationException($"The {name} contract has no required fields.");
        Assert.Equal(expected, required);
    }
}
