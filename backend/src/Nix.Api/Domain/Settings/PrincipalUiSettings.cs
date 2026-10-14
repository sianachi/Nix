using Nix.Domain.Identity;
using Nix.Domain.Tenancy;

namespace Nix.Domain.Settings;

/// <summary>
/// One person's synced interface preferences, kept apart from <c>principal_preferences</c> so the
/// notification form's whole-document save and this store's per-key merges never conflict.
/// </summary>
/// <remarks>A personal convenience, never a permission: nothing here grants or hides anything.</remarks>
public sealed class PrincipalUiSettings
{
    /// <summary>Gets the tenant whose principal owns these settings.</summary>
    public required TenantId TenantId { get; init; }

    /// <summary>Gets the owner.</summary>
    public required PrincipalId PrincipalId { get; init; }

    /// <summary>Gets the settings as a JSON object whose keys are the allow-list in <c>UiSettingsValidation</c>.</summary>
    public required string SettingsJson { get; init; }

    /// <summary>Gets the write counter; every merge advances it.</summary>
    public required long Revision { get; init; }
}
