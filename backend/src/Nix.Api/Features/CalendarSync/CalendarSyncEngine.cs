using System.Text.Json;
using System.Text.Json.Nodes;
using Nix.Abstractions;
using Nix.Abstractions.Calendar;
using Nix.Domain.Calendar;
using Nix.Domain.Items;
using Nix.Domain.Primitives;
using Nix.Domain.Properties;
using Nix.Features.Items;
using Nix.Features.Properties;
using Nix.Messaging;

namespace Nix.Features.CalendarSync;

/// <summary>
/// The Core side of one sync round (ADR-0052 steps 2-5 and Amendment 1 A8): applying pulled
/// events to items, selecting the item changes to push, recording push outcomes, storing the
/// cursor with a full resync's reconciliation, and the worker's own log rows. Runs inside the
/// worker execution's transaction, as the link owner; every item write goes through the ordinary
/// command handlers, with the <c>CalendarWrite</c> capability for the <c>$cal_</c> keys.
/// </summary>
public sealed class CalendarSyncEngine(
    ICalendarSyncStore store,
    IItemTree tree,
    IItemLocks locks,
    NixDispatcher dispatcher,
    INixSessionContextAccessor session,
    TimeProvider clock)
{
    /// <summary>The most events one C2 batch may carry.</summary>
    public const int MaxEventsPerBatch = 100;

    /// <summary>The most entries one C4 or C6 request may carry.</summary>
    public const int MaxEntries = 100;

    /// <summary>
    /// The encoded size one C3 page stops short of. The worker accepts 8 MiB; details escaped as
    /// <c>\uXXXX</c> make 100 changes approach 5 MiB, so Core stops adding at about 4 MiB.
    /// </summary>
    public const int MaxChangesPageBytes = 4 * 1024 * 1024;

    /// <summary>A full resync trashes nothing when it would remove more than this many events...</summary>
    public const int MassTrashMinimum = 20;

    /// <summary>The title an event without one is given.</summary>
    public const string UntitledEvent = "Untitled event";

    /// <summary>The detail of a log row for an event skipped because its item is under a lock.</summary>
    public const string ItemLockedDetail = "item_locked";

    private const string PairedElsewhereDetail = "the event is already paired with another item of this link";

    private const int MaxReconciledRows = 100_000;

    /// <summary>How far a reported window may lead or trail Core's: a round can cross midnight.</summary>
    private static readonly TimeSpan MidnightSlack = TimeSpan.FromDays(1);

    private static readonly PropertySchema BoundsSchema = new()
    {
        Properties =
        [
            new(CalendarContainerSchema.StartKey, "Start", PropertyType.DateTime, [], false),
            new(CalendarContainerSchema.EndKey, "End", PropertyType.DateTime, [], false),
        ],
        Inherit = false,
    };

    private NixSessionContext Context =>
        session.Current ?? throw new InvalidOperationException("No session context; the pipeline must establish one.");

    /// <summary>Checks a C2 batch's shape; returns a reason, or <see langword="null"/> when it is well formed.</summary>
    public static string? ValidatePull(CalendarPullRequest request)
    {
        ArgumentNullException.ThrowIfNull(request);
        if (request.Events.Count > MaxEventsPerBatch)
        {
            return "too many events";
        }

        foreach (var entry in request.Events)
        {
            if (entry is null
                || string.IsNullOrWhiteSpace(entry.ExternalId) || entry.ExternalId.Length > CalendarSyncRules.MaxExternalIdLength
                || entry.Version.Length > CalendarSyncRules.MaxVersionLength
                || entry.Status is not ("confirmed" or "cancelled")
                || entry.Title.Length > CalendarSyncRules.MaxTextLength
                || entry.Location.Length > CalendarSyncRules.MaxTextLength
                || entry.Details.Length > CalendarSyncRules.MaxDetailsLength
                || entry.Start.Length > 100 || entry.End is { Length: > 100 }
                || entry.UpdatedAt == default)
            {
                return "an event is malformed";
            }
        }

        return null;
    }

    /// <summary>
    /// C2: applies one batch of pulled events. Locks bind the sync as they bind anyone (Amendment 1
    /// A8): an event whose item is under a lock is skipped with an <c>item_locked</c> log row and its
    /// map left as it was, so its version is not advanced and the change still applies once the
    /// item is unlocked and the event is seen again.
    /// </summary>
    public async Task<CalendarPullResponse> PullAsync(
        CalendarLink link, CalendarPullRequest request, string executionId, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(link);
        ArgumentNullException.ThrowIfNull(request);
        var provider = (await store.GetConnectionAsync(link.ConnectionId, cancellationToken).ConfigureAwait(false))?.Provider ?? string.Empty;
        var log = new List<CalendarSyncLogEntry>();
        var applied = 0;
        var conflicts = 0;
        var locked = await LockedInBatchAsync(link, request, cancellationToken).ConfigureAwait(false);

        await store.SetSyncMarkerAsync(link.Id, cancellationToken).ConfigureAwait(false);
        foreach (var pulled in request.Events)
        {
            var outcome = await ApplyAsync(link, provider, pulled, request.Full ? executionId : null, locked, log, cancellationToken).ConfigureAwait(false);
            applied += outcome.Applied ? 1 : 0;
            conflicts += outcome.Conflict ? 1 : 0;
        }

        await store.SetSyncMarkerAsync(null, cancellationToken).ConfigureAwait(false);
        await store.AppendLogAsync(log, cancellationToken).ConfigureAwait(false);
        return new CalendarPullResponse(applied, conflicts);
    }

    /// <summary>
    /// The items of one batch that are under a lock, in one read: those its events are mapped to,
    /// and those its stamped events name.
    /// </summary>
    private async Task<HashSet<Guid>> LockedInBatchAsync(CalendarLink link, CalendarPullRequest request, CancellationToken cancellationToken)
    {
        var maps = await store.FindMapsByExternalAsync(
            link.Id, [.. request.Events.Select(pulled => pulled.ExternalId).Distinct(StringComparer.Ordinal)], cancellationToken)
            .ConfigureAwait(false);
        List<ItemId> items =
        [
            .. maps.Select(map => map.ItemId)
                .Concat(request.Events.Where(pulled => pulled.NixItemId is not null).Select(pulled => pulled.NixItemId!.Value))
                .Distinct()
                .Select(ItemId.From),
        ];
        return items.Count == 0
            ? []
            : [.. (await locks.LockedAmongAsync(items, cancellationToken).ConfigureAwait(false)).Select(id => id.Value)];
    }

    private async Task<(bool Applied, bool Conflict)> ApplyAsync(
        CalendarLink link, string provider, CalendarPullEvent pulled, string? seenExecution, HashSet<Guid> locked,
        List<CalendarSyncLogEntry> log, CancellationToken cancellationToken)
    {
        var now = clock.GetUtcNow();
        var map = await store.FindMapByExternalAsync(link.Id, pulled.ExternalId, cancellationToken).ConfigureAwait(false);
        if (map is { DeletedAt: null } && locked.Contains(map.ItemId))
        {
            log.Add(Log(link, "pull", "skipped", map.ItemId, pulled.ExternalId, ItemLockedDetail));
            return (false, false);
        }

        if (pulled.Status == "cancelled")
        {
            // A cancellation carries no content to check, so it is adopted only when its event id is
            // the stamp itself (a Google event id the worker chose): a third party cannot create an
            // event under that id, while any calendar writer could set a Graph transactionId.
            if ((map is null || map.DeletedAt is not null) && pulled.NixItemId is { } cancelledStamp
                && string.Equals(pulled.ExternalId, cancelledStamp.ToString("N"), StringComparison.Ordinal)
                && await store.FindUnconfirmedCreateAsync(link.Id, cancelledStamp, cancellationToken).ConfigureAwait(false) is { } cancelledCreate)
            {
                if (locked.Contains(cancelledStamp))
                {
                    log.Add(Log(link, "pull", "skipped", cancelledStamp, pulled.ExternalId, ItemLockedDetail));
                    return (false, false);
                }

                // A create whose report was lost, deleted upstream since: pair it so the deletion
                // applies below, and the create is never handed out (and revived) again.
                map = cancelledCreate with { ExternalEventId = pulled.ExternalId, PushOp = null, PushHash = null };
            }

            if (map is null || map.DeletedAt is not null)
            {
                return (false, false);
            }

            var mirrored = await tree.FindAsync(ItemId.From(map.ItemId), cancellationToken).ConfigureAwait(false);
            if (mirrored is { LifecycleState: ItemLifecycleState.Active } && mirrored.ParentId == link.ContainerItemId)
            {
                var deleted = await dispatcher.SendAsync<DeleteItem, ItemId>(new DeleteItem(mirrored.Id) { CalendarWrite = true }, cancellationToken).ConfigureAwait(false);
                if (deleted.IsFailure)
                {
                    log.Add(Log(link, "pull", "error", map.ItemId, pulled.ExternalId, deleted.Error.Code));
                    return (false, false);
                }
            }

            await store.SaveMapAsync(map with { DeletedAt = now, SeenExecution = seenExecution ?? map.SeenExecution, UpdatedAt = now }, cancellationToken)
                .ConfigureAwait(false);
            log.Add(Log(link, "pull", "deleted", map.ItemId, pulled.ExternalId, "deleted upstream"));
            return (true, false);
        }

        var fields = Normalize(pulled);
        if (!PropertyValidator.ValidateSupplied(BoundsJson(fields.Start, fields.End), BoundsSchema).IsEmpty)
        {
            log.Add(Log(link, "pull", "skipped", map?.ItemId, pulled.ExternalId, "invalid start/end"));
            return (false, false);
        }

        var hash = CalendarSyncRules.Hash(fields.Title, fields.Start, fields.End, fields.Location, fields.Details);
        if ((map is null || map.DeletedAt is not null) && pulled.NixItemId is { } stamp
            && await store.FindUnconfirmedCreateAsync(link.Id, stamp, cancellationToken).ConfigureAwait(false) is { } unconfirmed)
        {
            // A create whose C4 report was lost: the event carries the item id it was stamped with,
            // so it is adopted onto the pair that create was handed out on, never mirrored as a
            // second item (and never re-created upstream). Adoption never writes the item: a stamp
            // is not proof of origin (a calendar writer can set a Graph transactionId), so only an
            // event holding exactly what was pushed is confirmed as the report would have confirmed
            // it. Any other is paired with Nix as the winner - no nix_version and no synced hash, so
            // the next push restores the item's content over it, guarded by the version seen here.
            var unchanged = unconfirmed.PushHash is { } pushed && pushed.AsSpan().SequenceEqual(hash);
            map = unconfirmed with
            {
                ExternalEventId = pulled.ExternalId,
                ExternalVersion = EmptyToNull(pulled.Version),
                ExternalUpdatedAt = pulled.UpdatedAt,
                NixVersion = unchanged ? unconfirmed.PushNixVersion : null,
                LastSyncedHash = unchanged ? unconfirmed.PushHash : null,
                PushOp = null,
                PushHash = null,
                PushFailures = 0,
                SeenExecution = seenExecution ?? unconfirmed.SeenExecution,
                UpdatedAt = now,
            };
            if (!await store.SaveMapAsync(map, cancellationToken).ConfigureAwait(false))
            {
                log.Add(Log(link, "pull", "error", stamp, pulled.ExternalId, PairedElsewhereDetail));
                return (false, false);
            }

            log.Add(unchanged
                ? Log(link, "pull", "updated", stamp, pulled.ExternalId, "confirmed a pushed create")
                : Log(link, "pull", "conflict", stamp, pulled.ExternalId, "stamped event differs from the push; nix kept"));
            return (false, !unchanged);
        }

        if (map is null || map.DeletedAt is not null)
        {
            var created = await dispatcher.SendAsync<CreateItem, Item>(
                new CreateItem(link.WorkspaceId, "note", fields.Title, link.ContainerItemId, CreateProperties(link, provider, fields, pulled.ReadOnly))
                {
                    CalendarWrite = true,
                },
                cancellationToken).ConfigureAwait(false);
            if (created.IsFailure)
            {
                log.Add(Log(link, "pull", "error", null, pulled.ExternalId, created.Error.Code));
                return (false, false);
            }

            var stored = await tree.FindStoredAsync(created.Value.Id, cancellationToken).ConfigureAwait(false);
            var context = Context;
            var paired = await store.SaveMapAsync(
                new CalendarEventMap
                {
                    TenantId = context.TenantId,
                    Id = map?.Id ?? Guid.CreateVersion7(),
                    LinkId = link.Id,
                    PrincipalId = context.PrincipalId,
                    ItemId = created.Value.Id.Value,
                    ExternalEventId = pulled.ExternalId,
                    ExternalVersion = EmptyToNull(pulled.Version),
                    ExternalUpdatedAt = pulled.UpdatedAt,
                    NixVersion = stored?.LastModifiedAt ?? created.Value.LastModifiedAt,
                    LastSyncedHash = hash,
                    PushFailures = 0,
                    SeenExecution = seenExecution,
                    CreatedAt = map?.CreatedAt ?? now,
                    UpdatedAt = now,
                },
                cancellationToken).ConfigureAwait(false);
            log.Add(paired
                ? Log(link, "pull", "created", created.Value.Id.Value, pulled.ExternalId, "created")
                : Log(link, "pull", "error", created.Value.Id.Value, pulled.ExternalId, PairedElsewhereDetail));
            return (paired, false);
        }

        var item = await tree.FindAsync(ItemId.From(map.ItemId), cancellationToken).ConfigureAwait(false);
        if (item is null || item.LifecycleState != ItemLifecycleState.Active || item.ParentId != link.ContainerItemId)
        {
            // Trashed, purged or moved away in Nix: the push side deletes it upstream.
            if (seenExecution is not null)
            {
                await store.SaveMapAsync(map with { SeenExecution = seenExecution, UpdatedAt = now }, cancellationToken).ConfigureAwait(false);
            }

            return (false, false);
        }

        if (string.Equals(EmptyToNull(pulled.Version), map.ExternalVersion, StringComparison.Ordinal))
        {
            if (seenExecution is not null)
            {
                await store.SaveMapAsync(map with { SeenExecution = seenExecution, UpdatedAt = now }, cancellationToken).ConfigureAwait(false);
            }

            return (false, false);
        }

        var current = ItemFields.Read(item.Properties);
        var nixChanged = map.NixVersion is not { } synced || item.LastModifiedAt > synced
            ? !CalendarSyncRules.Hash(current.Title, current.Start, current.End, current.Location, current.Details)
                .AsSpan().SequenceEqual(map.LastSyncedHash ?? [])
            : false;
        var readOnly = pulled.ReadOnly || current.ReadOnly;
        if (CalendarSyncRules.Decide(readOnly, nixChanged, pulled.UpdatedAt, item.LastModifiedAt) == CalendarSyncWinner.Nix)
        {
            await store.SaveMapAsync(
                map with
                {
                    ExternalVersion = EmptyToNull(pulled.Version),
                    ExternalUpdatedAt = pulled.UpdatedAt,
                    PushFailures = 0,
                    SeenExecution = seenExecution ?? map.SeenExecution,
                    UpdatedAt = now,
                },
                cancellationToken).ConfigureAwait(false);
            log.Add(Log(link, "pull", "conflict", map.ItemId, pulled.ExternalId, "nix newer"));
            return (false, true);
        }

        if (!string.Equals(item.Properties is null ? string.Empty : ItemProperties.ReadTitle(item.Properties), fields.Title, StringComparison.Ordinal))
        {
            var renamed = await dispatcher.SendAsync<RenameItem, Item>(new RenameItem(item.Id, fields.Title) { CalendarWrite = true }, cancellationToken).ConfigureAwait(false);
            if (renamed.IsFailure)
            {
                log.Add(Log(link, "pull", "error", map.ItemId, pulled.ExternalId, renamed.Error.Code));
                return (false, false);
            }
        }

        var written = await dispatcher.SendAsync<SetItemProperties, Item>(
            new SetItemProperties(item.Id, UpdateProperties(fields, pulled.ReadOnly).ToJsonString()) { CalendarWrite = true },
            cancellationToken).ConfigureAwait(false);
        if (written.IsFailure)
        {
            log.Add(Log(link, "pull", "error", map.ItemId, pulled.ExternalId, written.Error.Code));
            return (false, false);
        }

        await store.SaveMapAsync(
            map with
            {
                ExternalVersion = EmptyToNull(pulled.Version),
                ExternalUpdatedAt = pulled.UpdatedAt,
                NixVersion = written.Value.LastModifiedAt,
                LastSyncedHash = hash,
                PushFailures = 0,
                SeenExecution = seenExecution ?? map.SeenExecution,
                UpdatedAt = now,
            },
            cancellationToken).ConfigureAwait(false);
        log.Add(nixChanged
            ? Log(link, "pull", "conflict", map.ItemId, pulled.ExternalId, "provider newer")
            : Log(link, "pull", "updated", map.ItemId, pulled.ExternalId, "updated"));
        return (true, nixChanged);
    }

    /// <summary>C3: one page of item changes to push, recorded as handed out.</summary>
    public async Task<CalendarChangesResponse> ChangesAsync(CalendarLink link, int limit, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(link);
        if (link.Direction != "two_way")
        {
            return new CalendarChangesResponse([]);
        }

        var changes = await SelectAsync(link, limit, record: true, cancellationToken).ConfigureAwait(false);
        return new CalendarChangesResponse(changes);
    }

    private async Task<List<CalendarChangeResponse>> SelectAsync(CalendarLink link, int limit, bool record, CancellationToken cancellationToken)
    {
        // Locked, read-only and parked rows, and starts no provider could take, never reach here:
        // the statement leaves them out before its LIMIT (F4), so they cannot fill every page.
        var candidates = await store.SelectPushCandidatesAsync(link, Math.Min(limit * 2, 200), cancellationToken).ConfigureAwait(false);
        var now = clock.GetUtcNow();
        var context = Context;
        var changes = new List<CalendarChangeResponse>(limit);
        var log = new List<CalendarSyncLogEntry>();
        var size = 16;

        foreach (var candidate in candidates)
        {
            if (changes.Count >= limit)
            {
                break;
            }

            var map = candidate.Map;
            CalendarChangeResponse change;
            CalendarEventMap recorded;
            if (candidate.Live)
            {
                if (candidate.LastModifiedAt is not { } modified)
                {
                    continue;
                }

                var fields = ItemFields.Read(candidate.Properties);
                if (fields.ReadOnly)
                {
                    continue;
                }

                if (!PropertyValidator.ValidateSupplied(BoundsJson(fields.Start, fields.End), BoundsSchema).IsEmpty)
                {
                    // Shaped like a date but not one (an unknown zone, a wrong offset): park the pair
                    // as if its pushes had failed, until the item is edited again.
                    if (record)
                    {
                        await store.SaveMapAsync(
                            (map ?? NewMap(link, context, candidate.ItemId, now)) with
                            {
                                PushNixVersion = modified,
                                PushOp = null,
                                PushHash = null,
                                PushFailures = CalendarSyncRules.MaxPushFailures,
                                UpdatedAt = now,
                            },
                            cancellationToken).ConfigureAwait(false);
                        log.Add(Log(link, "push", "skipped", candidate.ItemId, map?.ExternalEventId, "invalid start/end"));
                    }

                    continue;
                }

                // An edit since the last hand-out re-arms a pair whose pushes kept failing.
                var rearmed = map?.PushNixVersion is { } handedOut && modified > handedOut;

                var hash = CalendarSyncRules.Hash(fields.Title, fields.Start, fields.End, fields.Location, fields.Details);
                var confirmed = map is { DeletedAt: null, ExternalEventId: not null };
                if (confirmed && map!.LastSyncedHash is { } previous && previous.AsSpan().SequenceEqual(hash))
                {
                    // Touched but not changed where it matters: catch nix_version up silently.
                    if (record)
                    {
                        await store.SaveMapAsync(map with { NixVersion = modified, UpdatedAt = now }, cancellationToken).ConfigureAwait(false);
                    }

                    continue;
                }

                var op = confirmed ? "update" : "create";
                change = new CalendarChangeResponse(
                    candidate.ItemId,
                    confirmed ? map!.ExternalEventId : null,
                    confirmed ? map!.ExternalVersion : null,
                    op,
                    fields.Title,
                    fields.Start,
                    fields.End,
                    fields.Location,
                    fields.Details,
                    modified);
                recorded = confirmed
                    ? map! with { PushNixVersion = modified, PushHash = hash, PushOp = op, PushFailures = rearmed ? (short)0 : map.PushFailures, UpdatedAt = now }
                    : NewMap(link, context, candidate.ItemId, now) with
                    {
                        Id = map?.Id ?? Guid.CreateVersion7(),
                        PushNixVersion = modified,
                        PushHash = hash,
                        PushOp = op,
                        PushFailures = map is { DeletedAt: null } && !rearmed ? map.PushFailures : (short)0,
                        CreatedAt = map?.CreatedAt ?? now,
                    };
            }
            else
            {
                if (map is null)
                {
                    continue;
                }

                var fields = ItemFields.Read(candidate.Properties);
                if (map.ExternalEventId is null || (candidate.Properties is not null && fields.ReadOnly))
                {
                    // Never confirmed upstream, or an event the owner cannot edit there: the pair
                    // simply ends here.
                    if (record)
                    {
                        await store.SaveMapAsync(map with { DeletedAt = now, UpdatedAt = now }, cancellationToken).ConfigureAwait(false);
                    }

                    continue;
                }

                change = new CalendarChangeResponse(
                    candidate.ItemId, map.ExternalEventId, map.ExternalVersion, "delete", string.Empty, string.Empty, null,
                    string.Empty, string.Empty, candidate.LastModifiedAt ?? map.UpdatedAt);
                recorded = map with { PushNixVersion = candidate.LastModifiedAt, PushHash = null, PushOp = "delete", UpdatedAt = now };
            }

            var encoded = JsonSerializer.SerializeToUtf8Bytes(change, CalendarWorkerJsonContext.Default.CalendarChangeResponse).Length + 1;
            if (size + encoded > MaxChangesPageBytes && changes.Count > 0)
            {
                break;
            }

            size += encoded;
            changes.Add(change);
            if (record)
            {
                await store.SaveMapAsync(recorded, cancellationToken).ConfigureAwait(false);
            }
        }

        if (record)
        {
            await store.AppendLogAsync(log, cancellationToken).ConfigureAwait(false);
        }

        return changes;
    }

    private static CalendarEventMap NewMap(CalendarLink link, NixSessionContext context, Guid itemId, DateTimeOffset now) => new()
    {
        TenantId = context.TenantId,
        Id = Guid.CreateVersion7(),
        LinkId = link.Id,
        PrincipalId = context.PrincipalId,
        ItemId = itemId,
        PushFailures = 0,
        CreatedAt = now,
        UpdatedAt = now,
    };

    /// <summary>Checks a C4 report's shape.</summary>
    public static string? ValidatePushed(CalendarPushedRequest request)
    {
        ArgumentNullException.ThrowIfNull(request);
        if (request.Results.Count is 0 or > MaxEntries)
        {
            return "between 1 and 100 results";
        }

        return request.Results.Any(result => result is null
            || result.ItemId == Guid.Empty
            || result.ExternalId.Length > CalendarSyncRules.MaxExternalIdLength
            || result.Version.Length > CalendarSyncRules.MaxVersionLength
            || result.Status is not ("ok" or "conflict" or "gone" or "failed")
            || result.Detail is { Length: > CalendarSyncRules.MaxDetailLength })
            ? "a result is malformed"
            : null;
    }

    /// <summary>C4: records push outcomes, and schedules a follow-up round when changes remain.</summary>
    public async Task PushedAsync(CalendarLink link, CalendarPushedRequest request, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(link);
        ArgumentNullException.ThrowIfNull(request);
        var now = clock.GetUtcNow();
        var maps = (await store.FindMapsByItemsAsync(link.Id, [.. request.Results.Select(result => result.ItemId).Distinct()], cancellationToken)
            .ConfigureAwait(false)).ToDictionary(map => map.ItemId);
        var log = new List<CalendarSyncLogEntry>();

        foreach (var result in request.Results)
        {
            if (!maps.TryGetValue(result.ItemId, out var map) || map.PushOp is null)
            {
                log.Add(Log(link, "push", "error", null, EmptyToNull(result.ExternalId), "push result for an item that was not handed out"));
                continue;
            }

            var detail = CalendarSyncRules.Bound(CalendarSyncRules.Sanitize(result.Detail), CalendarSyncRules.MaxDetailLength);
            var failures = (short)Math.Min(map.PushFailures + 1, short.MaxValue);
            var logged = log.Count;
            CalendarEventMap next;
            switch (result.Status, map.PushOp)
            {
                case ("ok", "delete"):
                case ("gone", "delete"):
                    next = map with { DeletedAt = now };
                    log.Add(Log(link, "push", "deleted", map.ItemId, map.ExternalEventId, "deleted"));
                    break;
                case ("ok", _) when string.IsNullOrEmpty(result.ExternalId):
                    next = map with { PushFailures = failures };
                    log.Add(Log(link, "push", "error", map.ItemId, null, "the provider returned no event id"));
                    break;
                case ("ok", var op):
                    next = map with
                    {
                        ExternalEventId = result.ExternalId,
                        ExternalVersion = EmptyToNull(result.Version),
                        ExternalUpdatedAt = now,
                        NixVersion = map.PushNixVersion,
                        LastSyncedHash = map.PushHash,
                        PushFailures = 0,
                    };
                    log.Add(Log(link, "push", op == "create" ? "created" : "updated", map.ItemId, result.ExternalId, op == "create" ? "created" : "updated"));
                    break;
                case (_, "delete") when failures >= CalendarSyncRules.MaxPushFailures:
                    // An upstream delete that keeps failing - or keeps answering conflict - is given
                    // up: the pair ends here and the event stays upstream, rather than retrying (and
                    // re-enqueueing) every minute. Checked before the conflict case, which would
                    // otherwise leave a live pair with no item behind.
                    next = map with { PushFailures = failures, DeletedAt = now };
                    log.Add(Log(link, "push", "error", map.ItemId, map.ExternalEventId, detail.Length == 0 ? "push failed" : detail));
                    log.Add(Log(link, "push", "conflict", map.ItemId, map.ExternalEventId, "the upstream delete kept failing; the event was kept upstream"));
                    break;
                case ("conflict", _):
                    // Counted like a failure: the next pull normally settles it (and resets the
                    // count), but a conflict that pull cannot settle must not be retried forever.
                    next = map with { PushFailures = failures };
                    log.Add(Log(link, "push", "conflict", map.ItemId, map.ExternalEventId, detail.Length == 0 ? "provider changed first" : detail));
                    break;
                case ("gone", "update"):
                    next = map with { ExternalEventId = null, ExternalVersion = null, NixVersion = null, LastSyncedHash = null };
                    log.Add(Log(link, "push", "conflict", map.ItemId, map.ExternalEventId, "deleted upstream; recreating"));
                    break;
                default:
                    next = map with { PushFailures = failures };
                    log.Add(Log(link, "push", "error", map.ItemId, map.ExternalEventId, detail.Length == 0 ? "push failed" : detail));
                    break;
            }

            next = next with { PushOp = null, PushHash = next.DeletedAt is null ? next.PushHash : null, UpdatedAt = now };
            if (!await store.SaveMapAsync(next, cancellationToken).ConfigureAwait(false))
            {
                // The reported event already pairs another item of this link: keep this item
                // unconfirmed, count the failure, and record that instead of the outcome above.
                await store.SaveMapAsync(map with { PushOp = null, PushFailures = failures, UpdatedAt = now }, cancellationToken).ConfigureAwait(false);
                log.RemoveRange(logged, log.Count - logged);
                log.Add(Log(link, "push", "conflict", map.ItemId, EmptyToNull(result.ExternalId), PairedElsewhereDetail));
            }
        }

        await store.AppendLogAsync(log, cancellationToken).ConfigureAwait(false);
        if (link.Direction == "two_way" && (await SelectAsync(link, 1, record: false, cancellationToken).ConfigureAwait(false)).Count > 0)
        {
            await store.EnqueueDirtyAsync(link, now, cancellationToken).ConfigureAwait(false);
        }
    }

    /// <summary>
    /// C5: stores the cursor and, after a full resync, trashes the mapped events it did not see -
    /// only those whose start lies in the window, and nothing at all when that would remove more
    /// than 20 events and more than half of the window (the mass-trash guard).
    /// </summary>
    /// <remarks>
    /// The worker's word is not taken for what the round was. A full reconciliation runs only when
    /// this job was granted one (<paramref name="jobFull"/>, or a link state that made the session
    /// hand out no cursor); a claimed full round that was not granted stores no cursor and
    /// reconciles nothing, so the next round is a full one Core granted. The reconciliation's
    /// window is the reported one cut to the window Core computes now, give or take a day for a
    /// round that crossed midnight, so a wider claimed window trashes nothing more. Only an active
    /// child of the container is ever trashed; an unseen event whose item left the container just
    /// ends its pair, and one under a lock is kept whole.
    /// </remarks>
    public async Task CursorAsync(
        CalendarLink link, CalendarCursorRequest request, string executionId, bool jobFull, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(link);
        ArgumentNullException.ThrowIfNull(request);
        var now = clock.GetUtcNow();
        var (windowStart, windowEnd) = CalendarSyncRules.Window(now, link.WindowPastDays, link.WindowFutureDays);
        if (request.Full
            && !CalendarSyncRules.RequiresFullResync(jobFull, link.SyncCursor, link.CursorWindowStart, link.CursorWindowEnd, windowStart, windowEnd))
        {
            await store.StoreCursorAsync(link.Id, null, request.WindowStart, request.WindowEnd, now, cancellationToken).ConfigureAwait(false);
            await store.AppendLogAsync(
                [Log(link, "pull", "skipped", null, null, "full resync not granted to this round; the next round resyncs")],
                cancellationToken).ConfigureAwait(false);
            return;
        }

        // The link row is written last, after the reconciliation: its row lock (which firing and
        // "Sync now" also take) is then held only for the rest of the transaction, not across
        // every trash the reconciliation makes. A skipped reconciliation's error is set after the
        // cursor, whose store clears the last error.
        var error = request.Full
            ? await ReconcileAsync(link, request, executionId, windowStart, windowEnd, now, cancellationToken).ConfigureAwait(false)
            : null;
        await store.StoreCursorAsync(link.Id, request.Cursor, request.WindowStart, request.WindowEnd, now, cancellationToken).ConfigureAwait(false);
        if (error is not null)
        {
            await store.SetLinkErrorAsync(link.Id, null, error, now, cancellationToken).ConfigureAwait(false);
        }
    }

    /// <summary>
    /// A granted full resync's reconciliation; returns the link error to record when it was skipped.
    /// </summary>
    private async Task<string?> ReconcileAsync(
        CalendarLink link, CalendarCursorRequest request, string executionId, DateTimeOffset windowStart, DateTimeOffset windowEnd,
        DateTimeOffset now, CancellationToken cancellationToken)
    {
        var mapped = await store.ListMappedStartsAsync(link, MaxReconciledRows, cancellationToken).ConfigureAwait(false);
        if (mapped.Truncated)
        {
            // Deciding what the round did not see from part of the map could trash live events.
            var message = $"full resync reconciliation skipped: more than {MaxReconciledRows} mapped events";
            await store.AppendLogAsync([Log(link, "pull", "error", null, null, message)], cancellationToken).ConfigureAwait(false);
            return message;
        }

        var from = Max(request.WindowStart, windowStart - MidnightSlack);
        var to = Min(request.WindowEnd, windowEnd + MidnightSlack);
        var inWindow = mapped.Rows
            .Where(row => CalendarSyncRules.StartInstant(row.Start) is { } start && start >= from && start <= to)
            .ToList();
        var unseen = inWindow.Where(row => !string.Equals(row.Map.SeenExecution, executionId, StringComparison.Ordinal)).ToList();
        if (unseen.Count == 0)
        {
            return null;
        }

        List<ItemId> children = [.. unseen.Where(row => row.ItemActive).Select(row => ItemId.From(row.Map.ItemId))];
        var locked = children.Count == 0
            ? new HashSet<Guid>()
            : (await locks.LockedAmongAsync(children, cancellationToken).ConfigureAwait(false)).Select(id => id.Value).ToHashSet();
        var kept = unseen.Count(row => row.ItemActive && locked.Contains(row.Map.ItemId));
        unseen = [.. unseen.Where(row => !(row.ItemActive && locked.Contains(row.Map.ItemId)))];

        if (unseen.Count > MassTrashMinimum && unseen.Count * 2 > inWindow.Count)
        {
            var message = $"full resync would remove {unseen.Count} events; skipped";
            await store.AppendLogAsync([Log(link, "pull", "error", null, null, message)], cancellationToken).ConfigureAwait(false);
            return message;
        }

        var log = new List<CalendarSyncLogEntry>();
        if (kept > 0)
        {
            log.Add(Log(link, "pull", "skipped", null, null, $"{kept} unseen events under a lock were kept"));
        }

        await store.SetSyncMarkerAsync(link.Id, cancellationToken).ConfigureAwait(false);
        foreach (var row in unseen)
        {
            if (row.ItemActive)
            {
                var deleted = await dispatcher.SendAsync<DeleteItem, ItemId>(new DeleteItem(ItemId.From(row.Map.ItemId)) { CalendarWrite = true }, cancellationToken)
                    .ConfigureAwait(false);
                if (deleted.IsFailure)
                {
                    log.Add(Log(link, "pull", "error", row.Map.ItemId, row.Map.ExternalEventId, deleted.Error.Code));
                    continue;
                }
            }

            await store.SaveMapAsync(row.Map with { DeletedAt = now, UpdatedAt = now }, cancellationToken).ConfigureAwait(false);
            log.Add(Log(link, "pull", "deleted", row.Map.ItemId, row.Map.ExternalEventId,
                row.ItemActive ? "not in the full resync" : "not in the full resync; the item had left the container"));
        }

        await store.SetSyncMarkerAsync(null, cancellationToken).ConfigureAwait(false);
        await store.AppendLogAsync(log, cancellationToken).ConfigureAwait(false);
        return null;
    }

    private static DateTimeOffset Max(DateTimeOffset left, DateTimeOffset right) => left > right ? left : right;

    private static DateTimeOffset Min(DateTimeOffset left, DateTimeOffset right) => left < right ? left : right;

    /// <summary>Checks a C6 request's shape.</summary>
    public static string? ValidateLog(CalendarLogRequest request)
    {
        ArgumentNullException.ThrowIfNull(request);
        if (request.Entries.Count is 0 or > MaxEntries)
        {
            return "between 1 and 100 entries";
        }

        return request.Entries.Any(entry => entry is null
            || entry.Direction is not ("pull" or "push")
            || entry.Action is not ("error" or "skipped" or "conflict")
            || entry.Detail.Length > CalendarSyncRules.MaxDetailLength
            || entry.ExternalId is { Length: > CalendarSyncRules.MaxExternalIdLength }
            || entry.ItemId == Guid.Empty)
            ? "an entry is malformed"
            : null;
    }

    /// <summary>C6: records the worker's own log rows.</summary>
    public Task LogAsync(CalendarLink link, CalendarLogRequest request, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(link);
        ArgumentNullException.ThrowIfNull(request);
        return store.AppendLogAsync(
            [.. request.Entries.Select(entry => Log(
                link, entry.Direction, entry.Action, entry.ItemId, EmptyToNull(entry.ExternalId), CalendarSyncRules.Sanitize(entry.Detail)))],
            cancellationToken);
    }

    private CalendarSyncLogEntry Log(CalendarLink link, string direction, string action, Guid? itemId, string? externalId, string detail) => new()
    {
        TenantId = link.TenantId,
        Id = Guid.CreateVersion7(),
        LinkId = link.Id,
        PrincipalId = link.PrincipalId,
        At = clock.GetUtcNow(),
        Direction = direction,
        Action = action,
        ItemId = itemId,
        ExternalEventId = externalId is null ? null : CalendarSyncRules.Bound(externalId, CalendarSyncRules.MaxExternalIdLength),
        Detail = CalendarSyncRules.Bound(detail, CalendarSyncRules.MaxDetailLength),
    };

    private static string? EmptyToNull(string? value) => string.IsNullOrEmpty(value) ? null : value;

    private static EventFields Normalize(CalendarPullEvent pulled)
    {
        var title = CalendarSyncRules.Bound(CalendarSyncRules.Sanitize(pulled.Title).Trim(), CalendarSyncRules.MaxTextLength);
        return new EventFields(
            title.Length == 0 ? UntitledEvent : title,
            pulled.Start,
            string.IsNullOrEmpty(pulled.End) ? null : pulled.End,
            CalendarSyncRules.Bound(CalendarSyncRules.Sanitize(pulled.Location), CalendarSyncRules.MaxTextLength),
            CalendarSyncRules.Bound(CalendarSyncRules.Sanitize(pulled.Details), CalendarSyncRules.MaxDetailsLength),
            pulled.ReadOnly);
    }

    private static string BoundsJson(string start, string? end)
    {
        var bag = new JsonObject { [CalendarContainerSchema.StartKey] = start };
        if (end is not null)
        {
            bag[CalendarContainerSchema.EndKey] = end;
        }

        return bag.ToJsonString();
    }

    private static JsonObject CreateProperties(CalendarLink link, string provider, EventFields fields, bool readOnly)
    {
        var properties = new JsonObject
        {
            [CalendarContainerSchema.StartKey] = fields.Start,
            [ItemProperties.CalendarSourceKey] = provider,
            [ItemProperties.CalendarLinkKey] = link.Id.ToString("D"),
        };
        if (fields.End is not null)
        {
            properties[CalendarContainerSchema.EndKey] = fields.End;
        }

        if (fields.Location.Length > 0)
        {
            properties[CalendarContainerSchema.LocationKey] = fields.Location;
        }

        if (fields.Details.Length > 0)
        {
            properties[CalendarContainerSchema.DetailsKey] = fields.Details;
        }

        if (readOnly)
        {
            properties[ItemProperties.CalendarReadOnlyKey] = true;
        }

        return properties;
    }

    private static JsonObject UpdateProperties(EventFields fields, bool readOnly) => new()
    {
        [CalendarContainerSchema.StartKey] = fields.Start,
        [CalendarContainerSchema.EndKey] = fields.End,
        [CalendarContainerSchema.LocationKey] = fields.Location.Length > 0 ? fields.Location : null,
        [CalendarContainerSchema.DetailsKey] = fields.Details.Length > 0 ? fields.Details : null,
        [ItemProperties.CalendarReadOnlyKey] = readOnly ? true : null,
    };

    private sealed record EventFields(string Title, string Start, string? End, string Location, string Details, bool ReadOnly);

    /// <summary>The synced fields as an item currently holds them, read the way they are hashed.</summary>
    private sealed record ItemFields(string Title, string Start, string? End, string Location, string Details, bool ReadOnly)
    {
        internal static ItemFields Read(string? properties)
        {
            JsonObject? bag = null;
            try
            {
                bag = string.IsNullOrWhiteSpace(properties) ? null : JsonNode.Parse(properties) as JsonObject;
            }
            catch (JsonException)
            {
            }

            return new ItemFields(
                Text(bag, ItemProperties.TitleKey),
                Text(bag, CalendarContainerSchema.StartKey),
                bag?[CalendarContainerSchema.EndKey] is null ? null : Text(bag, CalendarContainerSchema.EndKey),
                Text(bag, CalendarContainerSchema.LocationKey),
                Text(bag, CalendarContainerSchema.DetailsKey),
                bag?[ItemProperties.CalendarReadOnlyKey] is JsonValue flag && flag.TryGetValue<bool>(out var readOnly) && readOnly);
        }

        private static string Text(JsonObject? bag, string key) =>
            bag?[key] switch
            {
                null => string.Empty,
                JsonValue value when value.TryGetValue<string>(out var text) => text,
                var other => other.ToJsonString(),
            };
    }
}
