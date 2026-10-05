namespace Nix.Features.DocumentImports;

/// <summary>The limits and validation rules an import upload and its worker reports must meet.</summary>
internal static class DocumentImportRules
{
    internal const long MaximumBytes = 100L * 1024 * 1024;

    internal static bool ValidPreviewResult(CompleteDocumentImportPreviewRequest value) =>
        ValidDigest(value.PlanSha256)
        && ValidDigest(value.SourceSha256)
        && value.PlanByteLength is > 0 and <= MaximumBytes
        && value.ItemCount is > 0 and <= 10_000
        && value.AssetCount is >= 0 and <= 10_000
        && value.Loss.Count <= 256
        && value.Omissions.Count <= 10_000
        && value.Loss.Concat(value.Omissions).All(entry => entry.Length <= 500);

    internal static bool ValidFailureCode(string code) =>
        !string.IsNullOrWhiteSpace(code)
        && code.Length <= 80
        && code.All(character => char.IsAsciiLetterOrDigit(character) || character is '.' or '_');

    internal static bool ValidDigest(string value) =>
        value.Length == 64
        && value.All(character => character is >= '0' and <= '9' or >= 'a' and <= 'f');

    internal static bool ValidName(string value) =>
        !string.IsNullOrWhiteSpace(value)
        && value.Length <= 255
        && value.IndexOfAny(['/', '\\', '\0']) < 0;

    internal static bool ValidMediaType(string value)
    {
        var separator = value.IndexOf('/', StringComparison.Ordinal);
        return separator > 0
            && separator < value.Length - 1
            && value.Length <= 160
            && value.All(character => character is >= (char)0x21 and <= (char)0x7e && character is not ';' and not '\\');
    }

    internal static string NormalizeFormat(string value)
    {
        var trimmed = value.Trim();
        if (trimmed.Equals("md", StringComparison.OrdinalIgnoreCase)
            || trimmed.Equals("markdown", StringComparison.OrdinalIgnoreCase))
        {
            return "markdown";
        }
        if (trimmed.Equals("text", StringComparison.OrdinalIgnoreCase)
            || trimmed.Equals("txt", StringComparison.OrdinalIgnoreCase))
        {
            return "txt";
        }
        foreach (var format in new[] { "pdf", "docx", "nix" })
        {
            if (trimmed.Equals(format, StringComparison.OrdinalIgnoreCase))
            {
                return format;
            }
        }
        return string.Empty;
    }
}
