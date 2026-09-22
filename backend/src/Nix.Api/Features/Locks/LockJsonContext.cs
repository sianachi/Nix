using System.Text.Json.Serialization;
using Nix.Features.Locks;

namespace Nix.Serialization;

/// <summary>Source-generated serialization for the item-lock contracts.</summary>
[JsonSourceGenerationOptions(PropertyNamingPolicy = JsonKnownNamingPolicy.CamelCase)]
[JsonSerializable(typeof(ItemLockResponse))]
[JsonSerializable(typeof(SetItemLockRequest))]
[JsonSerializable(typeof(ItemLockPasswordRequest))]
[JsonSerializable(typeof(UnlockItemResponse))]
internal sealed partial class LockJsonContext : JsonSerializerContext;
