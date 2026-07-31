using System.Text;
using Nix.Domain.Views;

namespace Nix.Features.Views;

/// <summary>
/// The view kinds this build defines, written out for a published description.
/// </summary>
/// <remarks>
/// <para>
/// <b>Descriptions that enumerate the kinds are generated, never typed.</b> A hand-written
/// "one of 'list', 'board', 'calendar'" goes stale the moment a kind is added, and these strings
/// are not comments: they are endpoint descriptions, so they publish straight into
/// <c>backend/openapi/nix-api.json</c> and from there into the generated frontend client. That
/// sentence had already been corrected independently three times, and was wrong again - missing
/// <c>timeline</c> - when this class was written.
/// </para>
/// <para>
/// Reading <see cref="ViewKinds.All"/> makes the table the one declaration a kind is added to:
/// adding an entry rewrites every published sentence, and the OpenAPI check in CI then insists the
/// regenerated document is committed with it. That includes what each kind must be given -
/// <see cref="RequirementsAside"/> reads <see cref="ViewRequirement.Missing"/> rather than
/// paraphrasing it, so the requirement and the sentence describing it cannot disagree.
/// </para>
/// <para>
/// <b>Every sentence here is count-agnostic.</b> Kinds can be retired as readily as added, so
/// nothing assumes a plural list: the surrounding prose keeps a singular subject, and an aside that
/// would be empty is emitted as nothing at all rather than as empty brackets.
/// </para>
/// <para>
/// All of them are built once at class initialisation. They are read while routes are being
/// registered at startup, never per request.
/// </para>
/// </remarks>
public static class ViewKindProse
{
    /// <summary>
    /// Every kind, quoted and joined, as in <c>'list', 'board' or 'calendar'</c>.
    /// </summary>
    public static string EveryKindListed { get; } =
        JoinQuoted(TextsOf(needingNothingOnly: false), " or ");

    /// <summary>
    /// The kinds that need nothing from the schema, quoted and joined, as in
    /// <c>'list' and 'gallery'</c>.
    /// </summary>
    /// <remarks>
    /// A kind with no requirement can always draw its items, which is why it can never be reported
    /// as unrenderable. Derived from the descriptor rather than named, for the same reason as
    /// <see cref="EveryKindListed"/>: a requirement-free kind added later belongs in this sentence
    /// too.
    /// </remarks>
    public static string KindsThatNeedNothing { get; } =
        JoinQuoted(TextsOf(needingNothingOnly: true), " and ");

    /// <summary>
    /// What each requirement-carrying kind must be given, as a parenthesised aside, as in
    /// <c> (a board needs a property to group by and a calendar needs a date property)</c>.
    /// </summary>
    /// <remarks>
    /// The aside carries its own leading space and brackets, and is the empty string when no kind
    /// carries a requirement, so the sentence around it stays grammatical at every count. Each
    /// clause is <see cref="ViewRequirement.Missing"/> verbatim - the same words a client is told
    /// when it leaves the field unset - rather than a second wording of the same rule.
    /// </remarks>
    public static string RequirementsAside { get; } = BuildRequirementsAside();

    /// <summary>Joins parts with commas, and the last two with a phrase of its own.</summary>
    /// <param name="parts">The parts, in order.</param>
    /// <param name="finalSeparator">What joins the last two, as in <c>" or "</c>.</param>
    /// <returns>
    /// The joined parts: nothing at all for none, the part itself for one, and
    /// <c>a, b and c</c> for three.
    /// </returns>
    public static string Join(IReadOnlyList<string> parts, string finalSeparator)
    {
        ArgumentNullException.ThrowIfNull(parts);

        var prose = new StringBuilder();

        for (var index = 0; index < parts.Count; index++)
        {
            if (index > 0)
            {
                prose.Append(index == parts.Count - 1 ? finalSeparator : ", ");
            }

            prose.Append(parts[index]);
        }

        return prose.ToString();
    }

    /// <summary>Quotes each text, then joins them.</summary>
    /// <param name="texts">The texts, in order.</param>
    /// <param name="finalSeparator">What joins the last two, as in <c>" or "</c>.</param>
    /// <returns>The quoted, joined texts, as in <c>'list', 'board' or 'calendar'</c>.</returns>
    public static string JoinQuoted(IReadOnlyList<string> texts, string finalSeparator)
    {
        ArgumentNullException.ThrowIfNull(texts);

        var quoted = new List<string>(texts.Count);

        foreach (var text in texts)
        {
            quoted.Add($"'{text}'");
        }

        return Join(quoted, finalSeparator);
    }

    private static List<string> TextsOf(bool needingNothingOnly)
    {
        var texts = new List<string>(ViewKinds.All.Length);

        foreach (var descriptor in ViewKinds.All)
        {
            if (!needingNothingOnly || descriptor.Requirement is null)
            {
                texts.Add(descriptor.Text);
            }
        }

        return texts;
    }

    private static string BuildRequirementsAside()
    {
        var clauses = new List<string>(ViewKinds.All.Length);

        foreach (var descriptor in ViewKinds.All)
        {
            if (descriptor.Requirement is { } requirement)
            {
                clauses.Add(requirement.Missing);
            }
        }

        return clauses.Count == 0 ? string.Empty : $" ({Join(clauses, " and ")})";
    }
}
