using Microsoft.AspNetCore.Mvc;
using Nix.Domain.Primitives;
using Nix.Errors;
using Nix.Features.Items;
using Nix.Http;

namespace Nix.Features.Recurrence;

/// <summary>
/// Route registration for an item's repeating rule: authoring it, and completing one occurrence at
/// a time.
/// </summary>
/// <remarks>
/// Every failure code this feature can raise is named here so two features can never collide, and
/// the frontend switches on the literal rather than on message text.
/// </remarks>
internal static class RecurrenceEndpoints
{
    /// <summary>
    /// Stable code for a written rule that does not fit the storage bound.
    /// </summary>
    /// <remarks>
    /// The same literal <c>Nix.Domain.Recurrence.RecurrenceErrors.TooLarge</c> constructs. Spelled
    /// out rather than referenced, the way <c>CalendarEndpoints.WorkspaceNotFoundCode</c> spells out
    /// a code owned elsewhere, so this feature's <see cref="Problem"/> mapping does not reach into
    /// the domain namespace for a string it can name itself; a test asserts the two agree.
    /// </remarks>
    internal const string TooLargeCode = "recurrence.rule_too_large";

    /// <summary>Stable code for an occurrence day the series does not land on.</summary>
    internal const string NotAnOccurrenceCode = "recurrence.not_an_occurrence";

    /// <summary>Stable code for a completion that would leave too many out-of-order exceptions.</summary>
    internal const string TooManyCompletionsCode = "recurrence.too_many_completions";

    /// <summary>
    /// Registers the recurrence feature's routes on <paramref name="endpoints"/>.
    /// </summary>
    internal static IEndpointRouteBuilder MapRecurrenceEndpoints(this IEndpointRouteBuilder endpoints)
    {
        ArgumentNullException.ThrowIfNull(endpoints);

        var items = endpoints.MapGroup("/api/v1/items").WithTags("Recurrence");

        items.MapPut("/{itemId:guid}/recurrence", SetItemRecurrenceEndpoint.Handle)
            .WithName("SetItemRecurrence")
            .WithSummary("Set or clear an item's repeating rule")
            .WithDescription(
                "A null request body clears the rule and the item stops repeating. Editing an "
                + "existing rule preserves its completion state: the watermark carries over "
                + "untouched and each individually completed day is kept only when the new rule "
                + "still lands on it. Fails with 'recurrence.invalid_frequency', "
                + "'recurrence.invalid_interval', 'recurrence.weekdays_require_weekly', "
                + "'recurrence.invalid_weekday' or 'recurrence.invalid_until' when the request is "
                + "malformed, and with 'recurrence.rule_too_large' when the resulting rule does not "
                + "fit.")
            .Produces<SetRecurrenceResponse>(StatusCodes.Status200OK)
            .ProducesProblem(StatusCodes.Status404NotFound)
            .ProducesProblem(StatusCodes.Status409Conflict)
            .ProducesProblem(StatusCodes.Status422UnprocessableEntity)
            .RequireRateLimiting(RateLimitRefusal.WritesPolicyName);

        items.MapPost("/{itemId:guid}/recurrence/completions", CompleteRecurrenceOccurrenceEndpoint.Handle)
            .WithName("CompleteRecurrenceOccurrence")
            .WithSummary("Complete one occurrence of an item's repeating series")
            .WithDescription(
                "Idempotent: completing an already-completed occurrence succeeds without writing "
                + "anything a second time. Fails with 'recurrence.not_recurring' when the item "
                + "carries no rule, 'recurrence.no_anchor' when it has no due date to anchor to, "
                + "'recurrence.unreadable_rule' when the stored rule cannot be read, and "
                + "'recurrence.not_an_occurrence' when the named day is not one the series lands "
                + "on.")
            .Produces<CompleteOccurrenceResponse>(StatusCodes.Status200OK)
            .ProducesProblem(StatusCodes.Status404NotFound)
            .ProducesProblem(StatusCodes.Status409Conflict)
            .ProducesProblem(StatusCodes.Status422UnprocessableEntity)
            .RequireRateLimiting(RateLimitRefusal.WritesPolicyName);

        return endpoints;
    }

    /// <summary>
    /// Maps a use case's failure onto the status its stable code implies.
    /// </summary>
    /// <param name="httpContext">The current request.</param>
    /// <param name="error">Why the use case failed.</param>
    /// <returns>Problem details describing the failure.</returns>
    /// <remarks>
    /// <para>
    /// A malformed request maps to 422: the request was understood and well-formed JSON, and what
    /// it asked for is what could not be done, the same reasoning <c>StructureEndpoints.Problem</c>
    /// applies to an invalid schema or property write.
    /// </para>
    /// <para>
    /// "No rule to act on", "no anchor to place it against" and "a stored rule this build cannot
    /// read" map to 409, alongside a lifecycle conflict: all four are the same shape of refusal -
    /// the request is fine, but the item's own current state is not one the operation can proceed
    /// from - and 409 is what <c>ItemEndpoints.LifecycleConflictCode</c> already uses for that
    /// shape.
    /// </para>
    /// </remarks>
    internal static ProblemDetails Problem(HttpContext httpContext, NixError error)
    {
        var status = error.Code switch
        {
            RecurrenceRequestErrors.InvalidFrequencyCode
                or RecurrenceRequestErrors.InvalidIntervalCode
                or RecurrenceRequestErrors.WeekdaysRequireWeeklyCode
                or RecurrenceRequestErrors.InvalidWeekdayCode
                or RecurrenceRequestErrors.InvalidUntilCode
                or RecurrenceRequestErrors.InvalidOccurredOnCode
                or TooLargeCode
                or NotAnOccurrenceCode
                or TooManyCompletionsCode => StatusCodes.Status422UnprocessableEntity,
            ItemEndpoints.LifecycleConflictCode
                or RecurrenceRequestErrors.NotRecurringCode
                or RecurrenceRequestErrors.NoAnchorCode
                or RecurrenceRequestErrors.UnreadableRuleCode => StatusCodes.Status409Conflict,
            _ => StatusCodes.Status404NotFound,
        };

        return ApiProblem.Create(httpContext, status, error.Code, "Request refused", error.Message);
    }
}
