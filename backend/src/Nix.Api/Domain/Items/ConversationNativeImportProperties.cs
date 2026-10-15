using System.Text.Json;
using System.Text.Json.Nodes;

namespace Nix.Domain.Items;

/// <summary>Restores only portable chat settings after the native import reserved-key filter.</summary>
public static class ConversationNativeImportProperties
{
    public static string? Restore(string? originalProperties, string? filteredProperties)
    {
        if (originalProperties is null || filteredProperties is null)
        {
            return filteredProperties;
        }
        try
        {
            var original = JsonNode.Parse(originalProperties) as JsonObject;
            if (original?["$chat_config"] is not JsonValue value || !value.TryGetValue<string>(out var json)
                || JsonNode.Parse(json) is not JsonObject config
                || config["petId"] is not JsonValue petValue || !petValue.TryGetValue<Guid>(out var petId) || petId == Guid.Empty
                || config["revision"] is not JsonValue revisionValue || !revisionValue.TryGetValue<long>(out var revision) || revision is < 1 or > 9007199254740991
                || config["sourceWorkspaceIds"] is not JsonArray sources || sources.Count is < 1 or > 40)
            {
                return filteredProperties;
            }
            var ids = new HashSet<Guid>();
            foreach (var source in sources)
            {
                if (source is not JsonValue sourceValue || !sourceValue.TryGetValue<Guid>(out var id) || id == Guid.Empty || !ids.Add(id))
                {
                    return filteredProperties;
                }
            }
            var portable = new JsonObject
            {
                ["petId"] = petId,
                ["revision"] = revision,
                ["sourceWorkspaceIds"] = sources.DeepClone(),
                ["turn"] = null,
                ["completedRequestIds"] = new JsonArray()
            };
            var filtered = JsonNode.Parse(filteredProperties)!.AsObject();
            filtered["$chat_config"] = portable.ToJsonString();
            return filtered.ToJsonString();
        }
        catch (Exception exception) when (exception is JsonException or InvalidOperationException or ArgumentException)
        {
            return filteredProperties;
        }
    }
}
