using System.Collections.Immutable;
using Nix.Domain.Identity;
using Nix.Domain.Items;
using Nix.Domain.Tenancy;

namespace Nix.Domain.Automations;

/// <summary>A validated rule document, before it is stored.</summary>
/// <param name="Name">What the owner calls it, 1..200 characters.</param>
/// <param name="Enabled">Whether it fires.</param>
/// <param name="ScopeItemId">The subtree it watches and may create under, or <see langword="null"/> for the whole workspace.</param>
/// <param name="Trigger">What starts it.</param>
/// <param name="Conditions">Checks on the triggering item, all of which must hold.</param>
/// <param name="Actions">What it does, all or nothing.</param>
public sealed record AutomationDefinition(
    string Name,
    bool Enabled,
    Guid? ScopeItemId,
    AutomationTrigger Trigger,
    ImmutableArray<AutomationCondition> Conditions,
    ImmutableArray<AutomationAction> Actions);

/// <summary>
/// One automation rule (ADR-0051 section 6, owner decision 1): a dedicated, owner-private row with
/// typed, versioned JSON, never an item a property write could reshape.
/// </summary>
public sealed class AutomationRule
{
    /// <summary>Gets the tenant, carried for row-level security.</summary>
    public required TenantId TenantId { get; init; }

    /// <summary>Gets the rule's identity.</summary>
    public required Guid Id { get; init; }

    /// <summary>Gets the workspace it watches and acts in.</summary>
    public required WorkspaceId WorkspaceId { get; init; }

    /// <summary>Gets the principal it belongs to and whose permissions its actions run under.</summary>
    public required PrincipalId OwnerPrincipalId { get; init; }

    /// <summary>Gets what the owner calls it.</summary>
    public required string Name { get; init; }

    /// <summary>Gets whether it fires.</summary>
    public required bool Enabled { get; init; }

    /// <summary>Gets the subtree it is limited to, or <see langword="null"/> for the whole workspace.</summary>
    public ItemId? ScopeItemId { get; init; }

    /// <summary>Gets the trigger's storage spelling, denormalised so indexes can select by it.</summary>
    public required string TriggerType { get; init; }

    /// <summary>Gets the watched key of a property rule, denormalised for the database trigger's join.</summary>
    public string? WatchKey { get; init; }

    /// <summary>Gets the stored trigger document.</summary>
    public required string Trigger { get; init; }

    /// <summary>Gets the stored condition list.</summary>
    public required string Conditions { get; init; }

    /// <summary>Gets the stored action list.</summary>
    public required string Actions { get; init; }

    /// <summary>Gets the document schema version the JSON was written in.</summary>
    public required short SchemaVersion { get; init; }

    /// <summary>Gets the compare-and-set revision.</summary>
    public required long Revision { get; init; }

    /// <summary>Gets how many runs in a row have failed.</summary>
    public required int ConsecutiveFailures { get; init; }

    /// <summary>Gets why the system disabled it, when it did.</summary>
    public string? DisabledReason { get; init; }

    /// <summary>Gets when it last ran (succeeded, did nothing, or failed).</summary>
    public DateTimeOffset? LastRunAt { get; init; }

    /// <summary>Gets when it was created.</summary>
    public required DateTimeOffset CreatedAt { get; init; }

    /// <summary>Gets when it was last changed.</summary>
    public required DateTimeOffset UpdatedAt { get; init; }
}

/// <summary>How a run started.</summary>
public enum AutomationOrigin
{
    /// <summary>A schedule occurrence.</summary>
    Schedule,

    /// <summary>A date arriving.</summary>
    Date,

    /// <summary>A property change.</summary>
    Property,

    /// <summary>A person pressed "run now".</summary>
    Manual,
}

/// <summary>How a run ended.</summary>
public enum AutomationRunStatus
{
    /// <summary>Every action ran.</summary>
    Succeeded,

    /// <summary>Every action ran and changed nothing (a value was already set).</summary>
    Noop,

    /// <summary>Re-verification found the trigger or a condition no longer true.</summary>
    Skipped,

    /// <summary>An action failed; nothing the rule did was kept.</summary>
    Failed,

    /// <summary>Over the per-item or per-hour bound.</summary>
    Throttled,

    /// <summary>Past the causation depth bound; recorded by the database trigger.</summary>
    Suppressed,
}

/// <summary>One record of a rule firing or deciding not to.</summary>
public sealed class AutomationRun
{
    /// <summary>Gets the tenant.</summary>
    public required TenantId TenantId { get; init; }

    /// <summary>Gets the run's identity.</summary>
    public required Guid Id { get; init; }

    /// <summary>Gets the rule.</summary>
    public required Guid RuleId { get; init; }

    /// <summary>Gets the rule's owner, for row-level security.</summary>
    public required PrincipalId OwnerPrincipalId { get; init; }

    /// <summary>Gets the rule's workspace.</summary>
    public required WorkspaceId WorkspaceId { get; init; }

    /// <summary>Gets the triggering item, when there was one.</summary>
    public Guid? ItemId { get; init; }

    /// <summary>Gets the key that makes a redelivered trigger record one run.</summary>
    public required string TriggerKey { get; init; }

    /// <summary>Gets how the run started.</summary>
    public required AutomationOrigin Origin { get; init; }

    /// <summary>Gets the causation depth.</summary>
    public required short Depth { get; init; }

    /// <summary>Gets how it ended.</summary>
    public required AutomationRunStatus Status { get; init; }

    /// <summary>Gets reason codes only, never a message or user text.</summary>
    public string? Detail { get; init; }

    /// <summary>Gets when it was recorded.</summary>
    public required DateTimeOffset CreatedAt { get; init; }
}

/// <summary>What a property rule last saw on one item, so a repeat is not a change.</summary>
public sealed class AutomationItemState
{
    /// <summary>Gets the tenant.</summary>
    public required TenantId TenantId { get; init; }

    /// <summary>Gets the rule.</summary>
    public required Guid RuleId { get; init; }

    /// <summary>Gets the item.</summary>
    public required ItemId ItemId { get; init; }

    /// <summary>Gets the rule's owner, for row-level security.</summary>
    public required PrincipalId OwnerPrincipalId { get; init; }

    /// <summary>Gets the hash of the watched value after the last run, if any.</summary>
    public string? LastValueHash { get; init; }

    /// <summary>Gets when the rule last fired for this item.</summary>
    public required DateTimeOffset LastFiredAt { get; init; }
}

/// <summary>The storage spellings of the automation enums.</summary>
public static class AutomationStorage
{
    /// <summary>Converts an origin to its stored spelling.</summary>
    public static string ToText(AutomationOrigin origin) => origin switch
    {
        AutomationOrigin.Schedule => "schedule",
        AutomationOrigin.Date => "date",
        AutomationOrigin.Property => "property",
        AutomationOrigin.Manual => "manual",
        _ => throw new ArgumentOutOfRangeException(nameof(origin), origin, "Unknown origin."),
    };

    /// <summary>Parses a stored origin.</summary>
    public static AutomationOrigin OriginFromText(string text) => text switch
    {
        "schedule" => AutomationOrigin.Schedule,
        "date" => AutomationOrigin.Date,
        "property" => AutomationOrigin.Property,
        "manual" => AutomationOrigin.Manual,
        _ => throw new InvalidOperationException($"Unknown stored automation origin '{text}'."),
    };

    /// <summary>Converts a status to its stored spelling.</summary>
    public static string ToText(AutomationRunStatus status) => status switch
    {
        AutomationRunStatus.Succeeded => "succeeded",
        AutomationRunStatus.Noop => "noop",
        AutomationRunStatus.Skipped => "skipped",
        AutomationRunStatus.Failed => "failed",
        AutomationRunStatus.Throttled => "throttled",
        AutomationRunStatus.Suppressed => "suppressed",
        _ => throw new ArgumentOutOfRangeException(nameof(status), status, "Unknown status."),
    };

    /// <summary>Parses a stored status.</summary>
    public static AutomationRunStatus StatusFromText(string text) => text switch
    {
        "succeeded" => AutomationRunStatus.Succeeded,
        "noop" => AutomationRunStatus.Noop,
        "skipped" => AutomationRunStatus.Skipped,
        "failed" => AutomationRunStatus.Failed,
        "throttled" => AutomationRunStatus.Throttled,
        "suppressed" => AutomationRunStatus.Suppressed,
        _ => throw new InvalidOperationException($"Unknown stored automation run status '{text}'."),
    };
}
