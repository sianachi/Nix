using System.Text.Json;
using System.Text.Json.Nodes;
using Nix.Domain.Finance;
using Nix.Domain.Habits;

namespace Nix.Domain.Items;

/// <summary>
/// What of the reserved <c>$</c> property space a bag may carry when it arrives as content - a
/// template captured from items, a template draft edited by a client, a template or document file
/// imported - rather than through the generic writes that refuse <c>$</c> keys outright.
/// </summary>
/// <remarks>
/// <para>
/// <b>An allowlist per feature, everything else dropped or refused.</b> Templates and imports
/// legitimately carry a habit's settings (<c>$habit_</c>) and a finance record's fields
/// (<c>$fin_</c>), because applying them recreates a tracker or a ledger. Nothing else in the
/// space is content: the set-by stamps are re-attributed to whoever applies, calendar sync keys
/// mirror an external event the copy is not, and any other <c>$</c> name is either a structural
/// query field or a key the server may yet claim.
/// </para>
/// <para>
/// <b>Allowlisted values are checked by their own validators when they are applied</b>
/// (<see cref="Refuse"/>), not trusted because a template or a file carried them: a malformed
/// <c>$habit_</c> or <c>$fin_</c> group would otherwise reach a tracker or a ledger that only
/// their own endpoints have ever written.
/// </para>
/// </remarks>
public static class ReservedPropertyContent
{
    /// <summary>The prefixes template and import content may carry.</summary>
    public static readonly IReadOnlyList<string> ContentPrefixes = [ItemProperties.HabitPrefix, FinanceKeys.Prefix];

    /// <summary>Whether a key is in the reserved space and outside <paramref name="allowed"/>.</summary>
    /// <param name="key">The key.</param>
    /// <param name="allowed">The prefixes the feature allows.</param>
    /// <returns><see langword="true"/> when the key must not be carried.</returns>
    public static bool IsForbidden(string key, IReadOnlyList<string> allowed)
    {
        ArgumentNullException.ThrowIfNull(key);
        ArgumentNullException.ThrowIfNull(allowed);
        return key.Length > 0 && key[0] == '$' && !allowed.Any(prefix => key.StartsWith(prefix, StringComparison.Ordinal));
    }

    /// <summary>The first key in a bag outside the allowlist, or null.</summary>
    /// <param name="bag">The bag as JSON, or null.</param>
    /// <param name="allowed">The prefixes the feature allows.</param>
    /// <returns>The key, or <see langword="null"/> (also for a bag that does not parse, which the caller's own validation refuses).</returns>
    public static string? FirstForbidden(string? bag, IReadOnlyList<string> allowed)
    {
        if (bag is null || !bag.Contains('$', StringComparison.Ordinal))
        {
            return null;
        }

        try
        {
            return JsonNode.Parse(bag) is JsonObject document
                ? document.Select(pair => pair.Key).FirstOrDefault(key => IsForbidden(key, allowed))
                : null;
        }
        catch (Exception error) when (error is JsonException or ArgumentException)
        {
            return null;
        }
    }

    /// <summary>A bag with every key outside the allowlist removed.</summary>
    /// <param name="bag">The bag as JSON, or null.</param>
    /// <param name="allowed">The prefixes the feature allows.</param>
    /// <returns>The bag, unchanged when it carries nothing to drop or does not parse.</returns>
    public static string? Strip(string? bag, IReadOnlyList<string> allowed)
    {
        if (bag is null || !bag.Contains('$', StringComparison.Ordinal))
        {
            return bag;
        }

        try
        {
            if (JsonNode.Parse(bag) is not JsonObject document)
            {
                return bag;
            }

            var forbidden = document.Select(pair => pair.Key).Where(key => IsForbidden(key, allowed)).ToList();
            if (forbidden.Count == 0)
            {
                return bag;
            }

            foreach (var key in forbidden)
            {
                document.Remove(key);
            }

            return document.ToJsonString();
        }
        catch (Exception error) when (error is JsonException or ArgumentException)
        {
            // Returned unchanged so the caller's envelope validation refuses it, as WithTitle does.
            return bag;
        }
    }

    /// <summary>
    /// The sentence refusing an allowlisted group whose values its own validator rejects, or null.
    /// </summary>
    /// <param name="bag">The bag about to be applied.</param>
    /// <param name="type">The item's type, for the finance readers.</param>
    /// <returns>The reason, or <see langword="null"/>.</returns>
    /// <remarks>
    /// Habit settings are judged by <see cref="HabitSettings.Read"/> whenever their defining key is
    /// present; a finance record by <see cref="FinanceAccount.Read"/> or
    /// <see cref="FinanceTransaction.Read"/> whenever it claims to be one. Other <c>$habit_</c> and
    /// <c>$fin_</c> keys (check-in marks, history versions, finance settings) are carried as they
    /// are, the same as the habit and finance endpoints read them fail-soft.
    /// </remarks>
    public static string? Refuse(string? bag, string type)
    {
        if (bag is null || !bag.Contains('$', StringComparison.Ordinal))
        {
            return null;
        }

        if (bag.Contains("\"$habit_frequency\"", StringComparison.Ordinal) && HabitSettings.Read(bag) is null)
        {
            return "a habit's settings are malformed";
        }

        if (FinanceAccount.Claims(bag) && FinanceAccount.Read(Guid.Empty, type, bag) is null)
        {
            return "a finance account's fields are malformed";
        }

        if (FinanceTransaction.Claims(bag) && FinanceTransaction.Read(Guid.Empty, type, bag) is null)
        {
            return "a finance transaction's fields are malformed";
        }

        return null;
    }
}
