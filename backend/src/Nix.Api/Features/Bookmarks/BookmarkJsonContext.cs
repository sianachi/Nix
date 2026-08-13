using System.Text.Json.Serialization;
using Nix.Features.Bookmarks;

namespace Nix.Serialization;

/// <summary>
/// The bookmark feature's JSON contract, source-generated.
/// </summary>
/// <remarks>
/// One context per feature; <c>Program</c> chains them all onto the serializer's resolver chain.
/// </remarks>
[JsonSourceGenerationOptions(PropertyNamingPolicy = JsonKnownNamingPolicy.CamelCase)]
[JsonSerializable(typeof(ShelfResponse))]
internal sealed partial class BookmarkJsonContext : JsonSerializerContext;
