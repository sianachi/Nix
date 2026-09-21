namespace Nix.Domain.Files;

/// <summary>Derives a file body's stored file name from an item's display title.</summary>
/// <remarks>
/// Renaming an item is a title edit, not a file operation, so the person doing it types a bare
/// name and does not think about the extension. This keeps the stored file name in step with that
/// title without ever letting a rename drop or double up the extension the bytes were uploaded
/// with.
/// </remarks>
public static class FileNaming
{
    /// <summary>
    /// Works out the file name a file body's current version should carry after its item is
    /// renamed to <paramref name="title"/>.
    /// </summary>
    /// <param name="title">The item's new display title, exactly as written to properties.</param>
    /// <param name="currentFileName">The current version's stored file name.</param>
    /// <returns>
    /// The new file name, or <see langword="null"/> when the title is empty after trimming and the
    /// file name should be left alone - an item mid-edit with a blank title is not a signal to
    /// strip the extension off a stored file.
    /// </returns>
    public static string? RenamedFileName(string title, string currentFileName)
    {
        ArgumentNullException.ThrowIfNull(title);
        ArgumentNullException.ThrowIfNull(currentFileName);

        var trimmed = title.Trim();
        if (trimmed.Length == 0)
        {
            return null;
        }

        var extension = Path.GetExtension(currentFileName);
        return extension.Length > 0 && trimmed.EndsWith(extension, StringComparison.OrdinalIgnoreCase)
            ? trimmed
            : trimmed + extension;
    }
}
