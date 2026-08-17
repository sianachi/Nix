using System.Globalization;

namespace Nix.Domain.Templates;

/// <summary>Lossless conversion for the decimal int64 sequence carried by JavaScript services.</summary>
public static class TemplateSequence
{
    /// <summary>Parses the complete signed 64-bit range without accepting locale-specific text.</summary>
    public static bool TryParse(string value, out long sequence) =>
        long.TryParse(value, NumberStyles.Integer, CultureInfo.InvariantCulture, out sequence);
}
