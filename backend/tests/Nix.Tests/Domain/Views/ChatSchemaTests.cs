using Nix.Domain.Properties;
using Nix.Domain.Views;

namespace Nix.Tests.Domain.Views;

public sealed class ChatSchemaTests
{
    [Fact]
    public void Chat_requires_message_fields_and_closed_role_options()
    {
        Assert.NotNull(ChatSchema.Refuse(PropertySchema.Empty));
        var schema = new PropertySchema
        {
            Inherit = false,
            Properties =
            [
                new("chat_role", "Role", PropertyType.Select, ["user", "assistant", "system"], false),
                new("chat_text", "Message", PropertyType.Text, [], false),
                new("chat_created_at", "Sent", PropertyType.Date, [], false),
                new("chat_author", "Author", PropertyType.Text, [], false),
            ],
        };
        Assert.Null(ChatSchema.Refuse(schema));
        var view = new ViewDefinition("chat", "Conversation", ViewKind.Chat, [], null, [], null, null, false);
        Assert.True(view.CanRender(schema));
        Assert.False(view.CanRender(PropertySchema.Empty));
        Assert.NotNull(ChatSchema.Refuse(schema with { Properties = schema.Properties.RemoveAt(0) }));
    }
}
