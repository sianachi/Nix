using Nix.Domain.Primitives;

namespace Nix.Features.Canvas;

/// <summary>
/// The expected failures of the canvas library feature, and the stable code clients branch on.
/// </summary>
public static class CanvasErrors
{
    /// <summary>Stable code for a library that exceeds the size a principal may store.</summary>
    public const string LibraryTooLargeCode = "canvas_library.too_large";

    /// <summary>The submitted library is larger than the stored bound allows.</summary>
    /// <returns>The error.</returns>
    public static NixError LibraryTooLarge() =>
        new(LibraryTooLargeCode, "The canvas library is too large to save.");
}
