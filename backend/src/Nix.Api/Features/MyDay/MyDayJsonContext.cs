using System.Text.Json.Serialization;
using Nix.Features.MyDay;

namespace Nix.Serialization;

/// <summary>The My Day feature's JSON contract, source-generated.</summary>
[JsonSourceGenerationOptions(PropertyNamingPolicy = JsonKnownNamingPolicy.CamelCase)]
[JsonSerializable(typeof(MyDayResponse))]
internal sealed partial class MyDayJsonContext : JsonSerializerContext;
