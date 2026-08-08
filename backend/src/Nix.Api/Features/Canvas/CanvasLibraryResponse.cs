using System.Text.Json.Nodes;

namespace Nix.Features.Canvas;

/// <summary>The caller's canvas library, as the API presents it.</summary>
/// <param name="Items">
/// The library items array, exactly as Excalidraw's own <c>libraryItems</c> shape and exactly as it
/// will be handed back to <c>Excalidraw</c>'s <c>libraryItems</c> prop. Opaque to the API.
/// </param>
internal sealed record CanvasLibraryResponse(JsonArray Items);

/// <summary>Replaces the caller's canvas library wholesale.</summary>
/// <param name="Items">The library's complete new contents.</param>
internal sealed record SaveCanvasLibraryRequest(JsonArray Items);
