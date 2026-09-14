using System.Collections.Immutable;
using Nix.Domain.Views;

namespace Nix.Tests.Domain.Views;

public sealed class HabitWidgetTests
{
    private static readonly HabitWidgetDefinition Widget = new("progress", "completion", Guid.Parse("11111111-1111-4111-8111-111111111111"), new DateOnly(2026, 9, 1), new DateOnly(2026, 9, 30));

    private static ViewDefinition View(ImmutableArray<HabitWidgetDefinition> widgets) =>
        new("habits", "Habits", ViewKind.HabitTracker, [], null, [], null, null, false, HabitWidgets: widgets);

    [Fact]
    public void Widget_configuration_and_order_survive_storage()
    {
        var second = Widget with { Id = "activity", Kind = "heatmap" };
        var stored = ViewDefinitionsJson.Write([View([Widget, second])], "habits");
        var read = ViewDefinitionsJson.Read(stored);
        Assert.Equal("habits", read.Default);
        Assert.Equal(new[] { Widget, second }, read.Views[0].HabitWidgets.ToArray());
        Assert.Null(ViewDefinitionRules.Refuse(read.Views, "habits"));
    }

    [Fact]
    public void Legacy_views_need_no_widgets()
    {
        var stored = ViewDefinitionsJson.Write([View([])], "habits");
        Assert.True(ViewDefinitionsJson.Read(stored).Views[0].HabitWidgets.IsDefaultOrEmpty);
    }

    [Fact]
    public void Invalid_widgets_are_refused_at_the_shared_write_boundary()
    {
        Assert.NotNull(ViewDefinitionRules.Refuse([View([Widget, Widget])], "habits"));
        Assert.NotNull(ViewDefinitionRules.Refuse([View([Widget with { Kind = "unknown" }])], "habits"));
        Assert.NotNull(ViewDefinitionRules.Refuse([View([Widget with { To = Widget.From.AddDays(-1) }])], "habits"));
        Assert.NotNull(ViewDefinitionRules.Refuse([View([Widget with { To = Widget.From.AddDays(366) }])], "habits"));
        Assert.NotNull(ViewDefinitionRules.Refuse([View([Widget with { HabitId = Guid.Empty }])], "habits"));
    }
}
