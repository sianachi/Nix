using Nix.Abstractions;
using Nix.Abstractions.Scheduling;
using Nix.Domain.Identity;
using Nix.Domain.Items;
using Nix.Domain.Notifications;
using Nix.Domain.Scheduling;

namespace Nix.Persistence.Scheduling;

/// <summary>
/// Fires once at the instant an item's <c>reminder</c> property names (ADR-0051 section 4).
/// </summary>
/// <remarks>
/// The recipient is the item's creator: unlike <c>due_date</c>, a reminder carries no per-set-by
/// attribution (<c>$due_set_by</c> exists for exactly one key), so there is no "who set this"
/// fact to prefer over the creator.
/// </remarks>
public sealed class ExplicitReminderSource(
    IReminderCandidateFinder candidates,
    IItemTree tree,
    IPermissionResolver permissions,
    IMutedContainerChecker mutedContainers,
    IPrincipalStatusChecker principalStatus,
    INotificationWriter notifications) : ITriggerSource
{
    private const int PageSize = 500;

    // A ceiling on how many pages one planning pass will follow for this source, not on how many
    // reminders may exist: past this many pages in one 60-second pass, the remainder waits for
    // the next one rather than this pass running arbitrarily long. 20 pages of 500 is 10,000
    // candidates in one window, comfortably past any realistic corpus today.
    private const int MaxPages = 20;

    /// <inheritdoc />
    public string Name => "reminder.explicit";

    /// <inheritdoc />
    public TriggerKind Kind => TriggerKind.Reminder;

    /// <inheritdoc />
    public async Task<IReadOnlyList<DesiredTrigger>> PlanAsync(PlanWindow window, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(window);

        // Padded a small amount behind window.Start, not just up to window.End: a reminder due a
        // moment before planning actually runs (ordinary processing latency, or a planning pass
        // that lands a beat late) would otherwise never be found at all, since FindExplicitAsync's
        // lower bound is exclusive of anything already in the past. Clamped back to window.Start
        // below, the same as DueTaskReminderSource and HabitReminderSource clamp an overdue
        // occurrence - never dropped, never fired early.
        var findFrom = window.Start.AddMinutes(-5);
        var found = new List<ExplicitReminderCandidate>();
        // Not DateTimeOffset.MinValue: Npgsql's date/timestamp range near the .NET minimum (year
        // 1) does not round-trip reliably as a bound parameter against Postgres's own much wider
        // range, and produced a NULL keyset comparison rather than the expected TRUE in testing.
        // Any instant safely before this system could ever have a real reminder is just as good a
        // "start of pagination" sentinel.
        var afterInstant = new DateTimeOffset(1900, 1, 1, 0, 0, 0, TimeSpan.Zero);
        var afterId = Guid.Empty;
        for (var page = 0; page < MaxPages; page++)
        {
            var batch = await candidates
                .FindExplicitAsync(findFrom, window.End, PageSize, afterInstant, afterId, cancellationToken)
                .ConfigureAwait(false);
            found.AddRange(batch);
            if (batch.Count < PageSize)
            {
                break;
            }

            var last = batch[^1];
            afterInstant = last.ReminderAt;
            afterId = last.ItemId;
        }

        if (found.Count == 0)
        {
            return [];
        }

        var preferences = await candidates
            .PreferencesForAsync(found.Select(candidate => candidate.PrincipalId).Distinct().ToArray(), cancellationToken)
            .ConfigureAwait(false);
        var preferencesByPrincipal = preferences.ToDictionary(entry => entry.PrincipalId);

        var desired = new List<DesiredTrigger>(found.Count);
        foreach (var candidate in found)
        {
            var clampedReminderAt = candidate.ReminderAt < window.Start ? window.Start : candidate.ReminderAt;
            var fireAt = preferencesByPrincipal.TryGetValue(candidate.PrincipalId, out var recipient)
                ? ReminderQuietHours.Apply(clampedReminderAt, recipient.TimeZone, recipient.QuietStart, recipient.QuietEnd)
                : clampedReminderAt;

            desired.Add(new DesiredTrigger(
                candidate.TenantId,
                candidate.WorkspaceId,
                candidate.PrincipalId,
                candidate.ItemId,
                null,
                fireAt,
                ReminderDedupeKeys.Explicit(candidate.ItemId, candidate.ReminderAt)));
        }

        return desired;
    }

    /// <inheritdoc />
    public async Task<TriggerOutcome> FireAsync(DueTrigger trigger, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(trigger);

        if (trigger.SourceItemId is not { } itemId)
        {
            return TriggerOutcome.Skipped("missing_item");
        }

        var item = await tree.FindAsync(ItemId.From(itemId), cancellationToken).ConfigureAwait(false);
        if (item is null || item.LifecycleState != ItemLifecycleState.Active)
        {
            return TriggerOutcome.Skipped("item_gone");
        }

        var currentInstant = ReminderInstant.Read(item.Properties);
        if (currentInstant is not { } instant)
        {
            return TriggerOutcome.Skipped("reminder_removed");
        }

        // Recomputing the dedupe key from the item's current state, rather than parsing the
        // trigger's own dedupe key back apart, is what lets this compare against exactly the same
        // rule PlanAsync used to produce it: if the reminder moved since this trigger was
        // planned, the key it would produce now differs, and this is stale regardless of whether
        // a later planning pass has caught up yet.
        if (ReminderDedupeKeys.Explicit(itemId, instant) != trigger.DedupeKey)
        {
            return TriggerOutcome.Skipped("reminder_changed");
        }

        // ADR-0051 section 2 lists "completed" as a skip reason generally, not only for a due
        // task: an item a reminder was set on may also carry a completion property (a checklist
        // item finished before its reminder fired, say), and a completed item's reminder is no
        // longer useful regardless of which source planned it.
        if (IsCompleted(item.Properties))
        {
            return TriggerOutcome.Skipped("item_completed");
        }

        if (!await principalStatus.IsActiveAsync(trigger.PrincipalId, cancellationToken).ConfigureAwait(false))
        {
            return TriggerOutcome.Skipped("recipient_not_active");
        }

        if (!await permissions.CanReadWorkspaceAsync(item.WorkspaceId, cancellationToken).ConfigureAwait(false))
        {
            return TriggerOutcome.Skipped("access_lost");
        }

        var recipientPreferences = await candidates
            .PreferencesForAsync([trigger.PrincipalId], cancellationToken)
            .ConfigureAwait(false);
        var mutedContainerIds = recipientPreferences.Count > 0
            ? recipientPreferences[0].MutedContainerIds
            : [];
        if (await mutedContainers.IsMutedAsync(itemId, mutedContainerIds, cancellationToken).ConfigureAwait(false))
        {
            return TriggerOutcome.Skipped("container_muted");
        }

        var title = ItemProperties.ReadTitle(item.Properties);
        var truncatedTitle = title.Length > 200 ? title[..200] : title;

        await notifications.CreateAsync(
            trigger.PrincipalId,
            NotificationKind.Reminder,
            truncatedTitle,
            "Reminder",
            ItemId.From(itemId),
            item.WorkspaceId,
            trigger.DedupeKey,
            cancellationToken).ConfigureAwait(false);

        return TriggerOutcome.Fired("reminder_fired");
    }

    /// <summary>Whether an item's own <c>completion</c> property, if it has one, is true.</summary>
    private static bool IsCompleted(string? properties)
    {
        if (string.IsNullOrWhiteSpace(properties))
        {
            return false;
        }

        try
        {
            return System.Text.Json.Nodes.JsonNode.Parse(properties) is System.Text.Json.Nodes.JsonObject bag
                && bag["completion"] is System.Text.Json.Nodes.JsonValue value
                && value.TryGetValue<bool>(out var completed)
                && completed;
        }
        catch (System.Text.Json.JsonException)
        {
            return false;
        }
    }
}
