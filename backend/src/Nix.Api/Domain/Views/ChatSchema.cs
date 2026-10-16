using Nix.Domain.Properties;

namespace Nix.Domain.Views;

/// <summary>The message fields a chat view reads from its ordinary child items.</summary>
public static class ChatSchema
{
    /// <summary>Returns a reason when a schema cannot render a conversation.</summary>
    public static string? Refuse(PropertySchema schema)
    {
        ArgumentNullException.ThrowIfNull(schema);
        if (schema.Find("chat_role") is not { Type: PropertyType.Select } role
            || role.ChoiceSource is not null
            || !role.Options.Contains("user", StringComparer.Ordinal)
            || !role.Options.Contains("assistant", StringComparer.Ordinal)
            || !role.Options.Contains("system", StringComparer.Ordinal)
            || schema.Find("chat_text")?.Type != PropertyType.Text
            || schema.Find("chat_created_at")?.Type != PropertyType.Date
            || schema.Find("chat_author")?.Type != PropertyType.Text)
        {
            return "A chat needs chat_role (select: user, assistant, system), chat_text (text), chat_created_at (date), and chat_author (text) fields.";
        }

        return null;
    }
}
