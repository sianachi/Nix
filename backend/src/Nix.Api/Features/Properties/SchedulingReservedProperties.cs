using Nix.Domain.Items;
using Nix.Domain.Primitives;

namespace Nix.Features.Properties;

/// <summary>
/// The one refusal both generic property write paths (<see cref="SetItemPropertiesHandler"/> and
/// <c>CreateItemHandler</c>) give a key the scheduler or the habit endpoints own.
/// </summary>
internal static class SchedulingReservedProperties
{
    /// <summary>The error a generic write naming a reserved scheduling key receives.</summary>
    internal static NixError Error { get; } = new(
        "scheduling.reserved_property",
        "Reminder attribution and habit properties are written by the server and cannot be written directly.");

    /// <summary>
    /// Whether a generic write must refuse <paramref name="key"/>. A trusted habit dispatch may
    /// write <c>$habit_</c> keys; nothing may write a set-by key directly.
    /// </summary>
    internal static bool IsRefused(string key, bool habitWrite) =>
        ItemProperties.IsReservedSchedulingKey(key)
        && !(habitWrite && key.StartsWith(ItemProperties.HabitPrefix, StringComparison.Ordinal));
}
