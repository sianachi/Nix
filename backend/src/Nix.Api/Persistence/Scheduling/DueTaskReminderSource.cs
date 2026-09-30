using System.Globalization;
using System.Text.Json;
using System.Text.Json.Nodes;
using Nix.Abstractions;
using Nix.Abstractions.Scheduling;
using Nix.Domain.Identity;
using Nix.Domain.Items;
using Nix.Domain.Notifications;
using Nix.Domain.Recurrence;
using Nix.Domain.Scheduling;

namespace Nix.Persistence.Scheduling;

/// <summary>
/// Fires at <c>due_reminder_time</c>, in the recipient's own zone, on an item's due day - and on
/// every occurrence day a recurring item produces, skipping any already complete (ADR-0051 section
/// 4). The recipient is whoever set the due date (<c>$due_set_by</c>), falling back to the item's
/// creator when that is absent.
/// </summary>
public sealed class DueTaskReminderSource(
    IReminderCandidateFinder candidates,
    IItemTree tree,
    IPermissionResolver permissions,
    IMutedContainerChecker mutedContainers,
    IPrincipalStatusChecker principalStatus,
    INotificationWriter notifications) : ITriggerSource
{
    private const int PageSize = 500;

    // See ExplicitReminderSource's identical constant: a ceiling on pages per pass, not on how
    // many due reminders may exist.
    private const int MaxPages = 20;

    /// <inheritdoc />
    public string Name => "reminder.due";

    /// <inheritdoc />
    public TriggerKind Kind => TriggerKind.Reminder;

    /// <inheritdoc />
    public async Task<IReadOnlyList<DesiredTrigger>> PlanAsync(PlanWindow window, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(window);

        var windowStartDay = DateOnly.FromDateTime(window.Start.UtcDateTime);
        // A recipient's due_reminder_time can push an occurrence's fire instant up to 24h past
        // its due day (a 09:00 reminder on a day whose midnight already fell inside the plan
        // window's start needs the day *before* window.Start considered too), so the day range
        // handed to the finder is widened by one on each side and the resulting fire instants are
        // filtered back down to the real window below.
        var findFrom = windowStartDay.AddDays(-1);
        var findTo = DateOnly.FromDateTime(window.End.UtcDateTime).AddDays(1);

        var found = new List<DueReminderCandidate>();
        // Not DateOnly.MinValue - see ExplicitReminderSource's identical note on its own keyset
        // sentinel.
        var afterDay = new DateOnly(1900, 1, 1);
        var afterId = Guid.Empty;
        for (var page = 0; page < MaxPages; page++)
        {
            var batch = await candidates
                .FindDueAsync(findFrom, findTo, PageSize, afterDay, afterId, cancellationToken)
                .ConfigureAwait(false);
            found.AddRange(batch);
            if (batch.Count < PageSize)
            {
                break;
            }

            var last = batch[^1];
            afterDay = last.DueDay;
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
            if (!preferencesByPrincipal.TryGetValue(candidate.PrincipalId, out var recipient))
            {
                continue;
            }

            if (!recipient.DueReminders)
            {
                continue;
            }

            // Occurrence day, and the instant its due_reminder_time names before any clamping or
            // quiet-hours deferral - computed for every candidate occurrence in the window (plus
            // findFrom's one-day pad, to catch a recipient whose zone puts "today" ahead of
            // window.Start's UTC calendar day) so the overdue-collapsing rule below can see all
            // of them at once.
            var occurrences = OccurrenceDays(candidate, findFrom, findTo)
                .Select(day => (Day: day, NaiveFireAt: LocalInstant(day, recipient.DueReminderTime, recipient.TimeZone)))
                .Where(occurrence => occurrence.NaiveFireAt < window.End)
                .ToList();

            // Of any occurrences whose natural instant already passed window.Start, only the
            // single most recent is kept, to be clamped to "now" below: a daily item, planned
            // fresh for the first time, would otherwise have both yesterday's and today's
            // occurrence in this list at once (the one-day pad above exists to catch a boundary
            // case, not to resurrect a whole extra day), firing two reminders together instead of
            // the one still actually owed. A steadily-running scheduler never accumulates more
            // than one overdue occurrence in the first place, since each is fired or skipped
            // within the same day it becomes due; collapsing here only matters for a cold start
            // or an outage.
            var mostRecentOverdue = occurrences
                .Where(occurrence => occurrence.NaiveFireAt < window.Start)
                .OrderByDescending(occurrence => occurrence.Day)
                .Take(1);
            var dueNow = occurrences.Where(occurrence => occurrence.NaiveFireAt >= window.Start);

            foreach (var (occurrenceDay, naiveFireAt) in dueNow.Concat(mostRecentOverdue))
            {
                var clampedFireAt = naiveFireAt < window.Start ? window.Start : naiveFireAt;
                var fireAt = ReminderQuietHours.Apply(clampedFireAt, recipient.TimeZone, recipient.QuietStart, recipient.QuietEnd);
                desired.Add(new DesiredTrigger(
                    candidate.TenantId,
                    candidate.WorkspaceId,
                    candidate.PrincipalId,
                    candidate.ItemId,
                    null,
                    fireAt,
                    ReminderDedupeKeys.Due(candidate.ItemId, occurrenceDay)));
            }
        }

        return desired;
    }

    /// <summary>Every not-yet-complete occurrence day a candidate produces in a window.</summary>
    private static IEnumerable<DateOnly> OccurrenceDays(DueReminderCandidate candidate, DateOnly from, DateOnly to)
    {
        if (candidate.Recurrence is null)
        {
            if (!candidate.Completed && candidate.DueDay >= from && candidate.DueDay <= to)
            {
                yield return candidate.DueDay;
            }

            yield break;
        }

        var rule = RecurrenceRuleJson.Read(candidate.Recurrence);
        if (rule is null)
        {
            yield break;
        }

        foreach (var day in RecurrenceExpansion.Occurrences(rule, candidate.DueDay, from, to))
        {
            if (!rule.IsCompleted(day))
            {
                yield return day;
            }
        }
    }

    /// <summary>The instant a local day and time-of-day mean in a zone.</summary>
    private static DateTimeOffset LocalInstant(DateOnly day, TimeOnly time, string timeZone) =>
        ReminderQuietHours.ResolveLocalInstant(day, time, timeZone);

    /// <inheritdoc />
    public async Task<TriggerOutcome> FireAsync(DueTrigger trigger, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(trigger);

        if (trigger.SourceItemId is not { } itemId || !TryParseOccurrenceDay(trigger.DedupeKey, out var occurrenceDay))
        {
            return TriggerOutcome.Skipped("missing_item");
        }

        var item = await tree.FindAsync(ItemId.From(itemId), cancellationToken).ConfigureAwait(false);
        if (item is null || item.LifecycleState != ItemLifecycleState.Active)
        {
            return TriggerOutcome.Skipped("item_gone");
        }

        var recipientId = ResolveRecipient(item);
        if (recipientId != trigger.PrincipalId)
        {
            return TriggerOutcome.Skipped("recipient_changed");
        }

        var stillDue = item.Recurrence is { } recurrenceJson
            ? IsRecurringOccurrenceStillDue(recurrenceJson, item.DueDay, occurrenceDay)
            : IsPlainOccurrenceStillDue(item, occurrenceDay);
        if (!stillDue)
        {
            return TriggerOutcome.Skipped("occurrence_changed");
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
        if (recipientPreferences.Count == 0 || !recipientPreferences[0].DueReminders)
        {
            return TriggerOutcome.Skipped("due_reminders_disabled");
        }

        if (await mutedContainers.IsMutedAsync(itemId, recipientPreferences[0].MutedContainerIds, cancellationToken).ConfigureAwait(false))
        {
            return TriggerOutcome.Skipped("container_muted");
        }

        var title = ItemProperties.ReadTitle(item.Properties);
        var truncatedTitle = title.Length > 200 ? title[..200] : title;

        await notifications.CreateAsync(
            trigger.PrincipalId,
            NotificationKind.Reminder,
            truncatedTitle,
            "Due today",
            ItemId.From(itemId),
            item.WorkspaceId,
            trigger.DedupeKey,
            cancellationToken).ConfigureAwait(false);

        return TriggerOutcome.Fired("due_reminder_fired");
    }

    /// <summary>Recovers the occurrence day a "due:{itemId}:{yyyy-MM-dd}" dedupe key names.</summary>
    private static bool TryParseOccurrenceDay(string dedupeKey, out DateOnly occurrenceDay)
    {
        occurrenceDay = default;
        const string prefix = "due:";
        if (!dedupeKey.StartsWith(prefix, StringComparison.Ordinal))
        {
            return false;
        }

        var lastColon = dedupeKey.LastIndexOf(':');
        if (lastColon < prefix.Length)
        {
            return false;
        }

        return DateOnly.TryParseExact(
            dedupeKey[(lastColon + 1)..],
            "yyyy-MM-dd",
            CultureInfo.InvariantCulture,
            DateTimeStyles.None,
            out occurrenceDay);
    }

    private static PrincipalId ResolveRecipient(Item item)
    {
        if (item.Properties is not null
            && JsonNode.Parse(item.Properties) is JsonObject bag
            && bag[ItemProperties.DueSetByKey] is JsonValue value
            && value.TryGetValue<string>(out var text)
            && Guid.TryParseExact(text, "D", out var principalGuid))
        {
            return PrincipalId.From(principalGuid);
        }

        return item.CreatedBy;
    }

    private static bool IsPlainOccurrenceStillDue(Item item, DateOnly occurrenceDay)
    {
        if (item.DueDay is null
            || !DateOnly.TryParseExact(item.DueDay, "yyyy-MM-dd", CultureInfo.InvariantCulture, DateTimeStyles.None, out var dueDay)
            || dueDay != occurrenceDay)
        {
            return false;
        }

        try
        {
            var bag = JsonNode.Parse(item.Properties ?? "{}") as JsonObject;
            var completed = bag?["completion"] is JsonValue completion && completion.TryGetValue<bool>(out var value) && value;
            return !completed;
        }
        catch (JsonException)
        {
            return true;
        }
    }

    private static bool IsRecurringOccurrenceStillDue(string recurrenceJson, string? anchorText, DateOnly occurrenceDay)
    {
        if (anchorText is null
            || !DateOnly.TryParseExact(anchorText, "yyyy-MM-dd", CultureInfo.InvariantCulture, DateTimeStyles.None, out var anchor))
        {
            return false;
        }

        var rule = RecurrenceRuleJson.Read(recurrenceJson);
        if (rule is null)
        {
            return false;
        }

        // The occurrence must still be one the rule actually produces on this day - not merely
        // "not yet completed" - so a rule edited since planning (a new interval, a new Until) that
        // no longer lands on this day is caught here too.
        var producesDay = RecurrenceExpansion.Occurrences(rule, anchor, occurrenceDay, occurrenceDay).Any();
        return producesDay && !rule.IsCompleted(occurrenceDay);
    }
}
