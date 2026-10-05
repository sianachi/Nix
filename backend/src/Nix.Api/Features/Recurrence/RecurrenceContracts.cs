namespace Nix.Features.Recurrence;

/// <summary>
/// Sets or clears an item's repeating rule.
/// </summary>
/// <param name="Freq">One of <c>daily</c>, <c>weekly</c>, <c>monthly</c>, <c>yearly</c>.</param>
/// <param name="Interval">
/// Every how many units the rule repeats; 1..<see cref="Nix.Domain.Recurrence.RecurrenceRuleJson.MaximumInterval"/>.
/// </param>
/// <param name="Weekdays">
/// Weekly rules only: two-letter ISO weekday codes (<c>mo</c>..<c>su</c>). Refused on any other
/// frequency.
/// </param>
/// <param name="Until">
/// The last day an occurrence may fall on, <c>yyyy-MM-dd</c>, or <see langword="null"/> for no end.
/// </param>
/// <remarks>
/// A <see langword="null"/> request body - not an instance of this type at all - clears the item's
/// rule; see <c>SetItemRecurrenceEndpoint</c>. This shape carries no completion state, because a
/// caller authoring a rule is not the one who decides what survives an edit -
/// <c>SetItemRecurrenceHandler</c> is.
/// </remarks>
public sealed record SetRecurrenceRequest(
    string Freq,
    int Interval,
    IReadOnlyList<string>? Weekdays,
    string? Until);

/// <summary>
/// An item's repeating rule, in its stored shape.
/// </summary>
/// <param name="Freq">One of <c>daily</c>, <c>weekly</c>, <c>monthly</c>, <c>yearly</c>.</param>
/// <param name="Interval">Every how many units the rule repeats.</param>
/// <param name="Weekdays">Weekly rules only: two-letter ISO weekday codes, empty otherwise.</param>
/// <param name="Until">The last day an occurrence may fall on, or <see langword="null"/> for no end.</param>
/// <param name="CompletedThrough">Every occurrence at or before this day is complete, or <see langword="null"/>.</param>
/// <param name="Completed">Completed occurrence days above the watermark, ascending.</param>
public sealed record RecurrenceRuleResponse(
    string Freq,
    int Interval,
    IReadOnlyList<string> Weekdays,
    string? Until,
    string? CompletedThrough,
    IReadOnlyList<string> Completed);

/// <summary>The result of setting or clearing an item's rule.</summary>
/// <param name="Rule">The rule now in force, or <see langword="null"/> when the item no longer repeats.</param>
public sealed record SetRecurrenceResponse(RecurrenceRuleResponse? Rule);

/// <summary>Completes one occurrence of an item's repeating series.</summary>
/// <param name="OccurredOn">The occurrence day, <c>yyyy-MM-dd</c>.</param>
public sealed record CompleteOccurrenceRequest(string OccurredOn);

/// <summary>The result of completing one occurrence.</summary>
/// <param name="Rule">The rule now in force.</param>
/// <param name="OccurredOn">Which day is now complete, <c>yyyy-MM-dd</c>.</param>
public sealed record CompleteOccurrenceResponse(RecurrenceRuleResponse? Rule, string OccurredOn);
