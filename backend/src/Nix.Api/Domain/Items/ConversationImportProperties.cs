using System.Text.Json;
using System.Text.Json.Nodes;

namespace Nix.Domain.Items;

/// <summary>Copied item content retains conversation settings, never an executable turn capability.</summary>
public static class ConversationImportProperties
{
    /// <summary>Interrupts a saved turn when its note leaves the active lifecycle.</summary>
    public static string? InterruptConfiguration(string? properties)
    {
        try
        {
            var bag = properties is null ? null : JsonNode.Parse(properties) as JsonObject;
            if (bag?["$chat_config"] is not JsonValue value || !value.TryGetValue<string>(out var json)
                || JsonNode.Parse(json) is not JsonObject config || config["turn"] is not JsonObject turn
                || turn["status"]?.GetValue<string>() != "running")
            {
                return null;
            }
            config["revision"] = (config["revision"]?.GetValue<long>() ?? 0) + 1;
            turn["status"] = "interrupted";
            turn["error"] = "The conversation was removed from the active workspace. Send a new message after restoring it.";
            return config.ToJsonString();
        }
        catch (Exception exception) when (exception is JsonException or InvalidOperationException)
        {
            return null;
        }
    }

    public static string? Sanitize(string? properties)
    {
        if (properties is null)
        {
            return null;
        }
        try
        {
            var bag = JsonNode.Parse(properties) as JsonObject;
            if (bag is null || !bag.ContainsKey("$chat_config"))
            {
                return properties;
            }
            if (bag["$chat_config"] is not JsonValue value || !value.TryGetValue<string>(out var json)
                || JsonNode.Parse(json) is not JsonObject configuration)
            {
                bag.Remove("$chat_config");
                return bag.ToJsonString();
            }
            configuration["turn"] = null;
            configuration["completedRequestIds"] = new JsonArray();
            bag["$chat_config"] = configuration.ToJsonString();
            return bag.ToJsonString();
        }
        catch (JsonException)
        {
            return properties;
        }
    }
}
