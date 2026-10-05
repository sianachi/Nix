using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Nix.Abstractions.Importing;
using Nix.Domain.Importing;
using Nix.Domain.Templates;

namespace Nix.Features.TemplateImports;

/// <summary>The limits and validation rules a template archive, its preview and its staged plan must meet.</summary>
internal static class TemplateImportRules
{
    internal const long MaximumArchiveBytes = 64L * 1024 * 1024;
    internal const int MaximumItems = 10_000;
    internal const int MaximumManagedImports = 200;

    internal static bool TryBuildTemplateImport(
        DocumentImportRecord operation,
        StageTemplateImportRequest request,
        out TemplateImportDescriptor descriptor,
        out IReadOnlyList<TemplateImportItem> items)
    {
        descriptor = null!;
        items = [];
        var preview = TemplateImportMapping.ParsePreview(operation.TemplatePreview);
        if (request.Profile is null
            || request.Items is null
            || preview is null
            || operation.SourceSha256 is null
            || !ProfileMatches(request.Profile, preview.Profile)
            || request.Items.Count != preview.ItemCount
            || request.Items.Count is < 1 or > MaximumItems
            || request.Items.Count(value => value.HasBody) != preview.BodyCount
            || request.Items.Count(value => value.ParentSourceId is null) != 1
            || (!request.Profile.IncludeChildren && request.Items.Count != 1)
            || request.Items.Single(value => value.ParentSourceId is null).ItemType != preview.RootItemType
            || request.Items.Any(value => !ValidOptionalObject(value.Properties)
                || !ValidOptionalObject(value.Schema)
                || !ValidOptionalObject(value.Views)
                || !ValidOptionalObject(value.Recurrence)))
        {
            return false;
        }
        var built = new TemplateImportItem[request.Items.Count];
        for (var index = 0; index < request.Items.Count; index++)
        {
            var item = request.Items[index];
            if (!TemplateSequence.TryParse(item.Seq, out var sequence))
            {
                return false;
            }
            built[index] = new TemplateImportItem(
                item.SourceId,
                item.ParentSourceId,
                item.ItemType,
                item.Title,
                sequence,
                Json(item.Properties),
                Json(item.Schema),
                Json(item.Views),
                item.HasBody,
                Json(item.Recurrence));
        }
        if (!TryInitialization(request.Profile.Initialization, out var initialization))
        {
            return false;
        }

        descriptor = new TemplateImportDescriptor(
            request.Profile.Key,
            request.Profile.Name,
            request.Profile.Description,
            operation.Purpose == DocumentImportPurposes.TemplateManaged ? TemplateOrigin.Managed : TemplateOrigin.User,
            operation.ManagedSource,
            operation.SourceSha256,
            request.Profile.IncludeBody,
            request.Profile.IncludeChildren,
            initialization);
        items = built;
        return true;
    }

    internal static string? Json(JsonElement? value) =>
        value is { ValueKind: JsonValueKind.Object } ? value.Value.GetRawText() : null;

    internal static bool TryInitialization(JsonElement? value, out TemplateInitialization? initialization)
    {
        if (value is null)
        {
            initialization = null;
            return true;
        }

        if (value.Value.ValueKind == JsonValueKind.Null)
        {
            initialization = null;
            return false;
        }

        return TemplateInitializationJson.TryRead(value.Value.GetRawText(), out initialization, out _);
    }

    internal static bool ProfileMatches(TemplateImportProfileResponse left, TemplateImportProfileResponse right)
    {
        if (left.Kind != right.Kind
            || left.Version != right.Version
            || left.Key != right.Key
            || left.Name != right.Name
            || left.Description != right.Description
            || left.IncludeBody != right.IncludeBody
            || left.IncludeChildren != right.IncludeChildren)
        {
            return false;
        }

        if (!TryInitialization(left.Initialization, out var leftInitialization)
            || !TryInitialization(right.Initialization, out var rightInitialization))
        {
            return false;
        }

        return string.Equals(
            TemplateInitializationJson.Write(leftInitialization ?? TemplateInitialization.Empty),
            TemplateInitializationJson.Write(rightInitialization ?? TemplateInitialization.Empty),
            StringComparison.Ordinal);
    }

    internal static bool ValidOptionalObject(JsonElement? value) =>
        value is null || value.Value.ValueKind is JsonValueKind.Null or JsonValueKind.Object;

    internal static bool ValidPreview(CompleteTemplateImportPreviewRequest value) =>
        ValidDigest(value.PlanSha256)
        && ValidDigest(value.SourceSha256)
        && value.PlanByteLength is > 0 and <= MaximumArchiveBytes
        && ValidProfile(value.Profile)
        && !string.IsNullOrWhiteSpace(value.RootItemType)
        && value.RootItemType.Length <= 64
        && value.ItemCount is > 0 and <= MaximumItems
        && value.BodyCount >= 0
        && value.BodyCount <= value.ItemCount
        && value.ViewCount is >= 0 and <= MaximumItems;

    internal static bool ValidProfile(TemplateImportProfileResponse? value) =>
        value is not null
        && value.Kind == "template"
        && value.Version == 1
        && !string.IsNullOrWhiteSpace(value.Key)
        && value.Key.Length <= 160
        && !string.IsNullOrWhiteSpace(value.Name)
        && value.Name.Length <= 200
        && value.Description is not null
        && value.Description.Length <= 1_000;

    internal static bool DigestEquals(string? expected, string? actual)
    {
        if (!ValidDigest(expected) || !ValidDigest(actual))
        {
            return false;
        }
        Span<byte> expectedBytes = stackalloc byte[64];
        Span<byte> actualBytes = stackalloc byte[64];
        Encoding.ASCII.GetBytes(expected, expectedBytes);
        Encoding.ASCII.GetBytes(actual, actualBytes);
        return CryptographicOperations.FixedTimeEquals(expectedBytes, actualBytes);
    }

    internal static bool ValidDigest(string? value) =>
        value is not null
        && value.Length == 64
        && value.All(character => character is >= '0' and <= '9' or >= 'a' and <= 'f');

    internal static bool ValidFailureCode(string? code) =>
        !string.IsNullOrWhiteSpace(code)
        && code.Length <= 80
        && code.All(character => char.IsAsciiLetterOrDigit(character) || character is '.' or '_');

    internal static bool ValidName(string? value) =>
        !string.IsNullOrWhiteSpace(value)
        && value.Length <= 255
        && value.IndexOfAny(['/', '\\', '\0']) < 0;

    internal static bool ValidMediaType(string? value)
    {
        if (string.IsNullOrWhiteSpace(value))
        {
            return false;
        }
        var separator = value.IndexOf('/', StringComparison.Ordinal);
        return separator > 0
            && separator < value.Length - 1
            && value.Length <= 160
            && value.All(character => character is >= (char)0x21 and <= (char)0x7e && character is not ';' and not '\\');
    }
}
