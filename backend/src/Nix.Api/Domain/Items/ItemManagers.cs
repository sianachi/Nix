namespace Nix.Domain.Items;

/// <summary>The values <see cref="Item.ManagedBy"/> takes.</summary>
public static class ItemManagers
{
    /// <summary>The container an external calendar is linked to.</summary>
    public const string CalendarContainer = "calendar";

    /// <summary>An event mirrored between a linked container and its external calendar.</summary>
    public const string CalendarEvent = "calendar_event";
}
