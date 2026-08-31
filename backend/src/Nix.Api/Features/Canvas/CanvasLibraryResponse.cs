using System.Text.Json.Nodes;

namespace Nix.Features.Canvas;

/// <summary>The caller's canvas library, as the API presents it.</summary>
/// <param name="Items">
/// The native library items array. Opaque to the API so the editor can evolve its item schema.
/// </param>
internal sealed record CanvasLibraryResponse(JsonArray Items);

/// <summary>Replaces the caller's canvas library wholesale.</summary>
/// <param name="Items">The library's complete new contents.</param>
internal sealed record SaveCanvasLibraryRequest(JsonArray Items);
