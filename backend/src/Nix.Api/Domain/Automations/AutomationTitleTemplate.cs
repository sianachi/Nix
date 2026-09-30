using System.Globalization;
using System.Text;

namespace Nix.Domain.Automations;

/// <summary>
/// Renders the two placeholders a title or body template may use - <c>{date}</c>, the owner's
/// local date, and <c>{item.title}</c>, the triggering item's title - as plain text.
/// </summary>
/// <remarks>
/// One left-to-right pass: substituted text is never scanned again, so an item titled
/// <c>{date}</c> stays literally that. Control characters are dropped (they come from item titles
/// the rule's author did not write), and the result is cut to the field's bound.
/// </remarks>
public static class AutomationTitleTemplate
{
    private const string DatePlaceholder = "{date}";
    private const string TitlePlaceholder = "{item.title}";

    /// <summary>Renders <paramref name="template"/>.</summary>
    /// <param name="template">The stored template.</param>
    /// <param name="localDate">The owner's local date at fire time.</param>
    /// <param name="itemTitle">The triggering item's title, or <see langword="null"/> when there is no item.</param>
    /// <param name="maximumLength">The field's bound.</param>
    public static string Render(string template, DateOnly localDate, string? itemTitle, int maximumLength)
    {
        ArgumentNullException.ThrowIfNull(template);
        var date = localDate.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture);
        var builder = new StringBuilder(template.Length + 32);
        var index = 0;
        while (index < template.Length)
        {
            if (string.CompareOrdinal(template, index, DatePlaceholder, 0, DatePlaceholder.Length) == 0)
            {
                builder.Append(date);
                index += DatePlaceholder.Length;
            }
            else if (string.CompareOrdinal(template, index, TitlePlaceholder, 0, TitlePlaceholder.Length) == 0)
            {
                builder.Append(itemTitle ?? string.Empty);
                index += TitlePlaceholder.Length;
            }
            else
            {
                builder.Append(template[index]);
                index++;
            }
        }

        var text = new StringBuilder(builder.Length);
        foreach (var character in builder.ToString())
        {
            if (!char.IsControl(character))
            {
                text.Append(character);
            }
        }

        var rendered = text.ToString();
        if (rendered.Length <= maximumLength)
        {
            return rendered;
        }

        // Never cut between the two halves of a surrogate pair.
        var cut = maximumLength;
        if (cut > 0 && char.IsHighSurrogate(rendered[cut - 1]))
        {
            cut--;
        }

        return rendered[..cut];
    }
}
