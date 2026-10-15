using System.Text.Json.Nodes;
using Nix.Domain.Items;

namespace Nix.Tests.Domain.Items;

public sealed class ConversationImportPropertiesTests
{
    [Fact]
    public void Import_retains_settings_and_content_but_cannot_revive_a_turn_or_deduplication_receipt()
    {
        var source = Guid.NewGuid();
        var pet = Guid.NewGuid();
        var config = new JsonObject
        {
            ["sourceWorkspaceIds"] = new JsonArray(JsonValue.Create(source)),
            ["petId"] = pet,
            ["revision"] = 8,
            ["turn"] = new JsonObject
            {
                ["status"] = "running",
                ["actorId"] = Guid.NewGuid(),
                ["requestId"] = Guid.NewGuid(),
                ["expiresAt"] = "2099-01-01T00:00:00Z"
            },
            ["completedRequestIds"] = new JsonArray(JsonValue.Create(Guid.NewGuid()))
        };
        var bag = new JsonObject { ["title"] = "Imported conversation", ["$chat_config"] = config.ToJsonString() };
        var sanitized = JsonNode.Parse(ConversationImportProperties.Sanitize(bag.ToJsonString())!)!;
        var result = JsonNode.Parse(sanitized["$chat_config"]!.GetValue<string>())!;
        Assert.Equal("Imported conversation", sanitized["title"]!.GetValue<string>());
        Assert.Equal(pet, result["petId"]!.GetValue<Guid>());
        Assert.Equal(source, result["sourceWorkspaceIds"]![0]!.GetValue<Guid>());
        Assert.Equal(8, result["revision"]!.GetValue<int>());
        Assert.Null(result["turn"]);
        Assert.Empty(result["completedRequestIds"]!.AsArray());
    }

    [Fact]
    public void Ordinary_items_are_unchanged()
    {
        Assert.Null(ConversationImportProperties.Sanitize(null));
        Assert.Equal("{\"title\":\"A note\"}", ConversationImportProperties.Sanitize("{\"title\":\"A note\"}"));
    }
}
