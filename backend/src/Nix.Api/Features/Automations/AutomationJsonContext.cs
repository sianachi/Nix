using System.Text.Json.Serialization;

namespace Nix.Features.Automations;

[JsonSourceGenerationOptions(PropertyNamingPolicy = JsonKnownNamingPolicy.CamelCase)]
[JsonSerializable(typeof(AutomationRuleInput))]
[JsonSerializable(typeof(UpdateAutomationRequest))]
[JsonSerializable(typeof(AutomationItemRequest))]
[JsonSerializable(typeof(AutomationRuleResponse))]
[JsonSerializable(typeof(AutomationListResponse))]
[JsonSerializable(typeof(AutomationRunResponse))]
[JsonSerializable(typeof(AutomationRunsPageResponse))]
[JsonSerializable(typeof(AutomationTestResponse))]
internal sealed partial class AutomationJsonContext : JsonSerializerContext;
