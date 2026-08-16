using System.Collections.Immutable;
using Nix.Domain.Views;
using Nix.Features.Views;

namespace Nix.Tests.Features.Views;

public sealed class ContainerViewsValidationTests
{
    [Fact]
    public void A_companion_must_exist_and_may_not_compose_again()
    {
        var missing = View("a") with { CompanionViewId = "missing", CompanionPlacement = "below" };
        Assert.NotNull(SetContainerViewsHandler.Validate([missing], null));

        var first = View("a") with { CompanionViewId = "b", CompanionPlacement = "beside" };
        var nested = View("b") with { CompanionViewId = "c", CompanionPlacement = "below" };
        Assert.NotNull(SetContainerViewsHandler.Validate([first, nested, View("c")], null));
    }

    [Fact]
    public void A_form_condition_may_only_reference_an_earlier_field()
    {
        var form = new InteractiveFormDefinition(
            [new FormPage(
                "page",
                "Page",
                null,
                [],
                [
                    new FormBlock(
                        "first",
                        "field",
                        "first",
                        "First",
                        null,
                        false,
                        null,
                        [new FormCondition("later", "equals", "yes")]),
                    new FormBlock("later", "field", "later", "Later", null, false, null, []),
                ])],
            "generated",
            null,
            "Done",
            "Thanks");
        var view = View("form") with { Kind = ViewKind.InteractiveForm, InteractiveForm = form };

        var refusal = SetContainerViewsHandler.Validate([view], null);

        Assert.NotNull(refusal);
        Assert.Contains("earlier field", refusal.Value.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void Valid_two_slot_composition_is_accepted()
    {
        var primary = View("form") with { CompanionViewId = "responses", CompanionPlacement = "below" };

        Assert.Null(SetContainerViewsHandler.Validate([primary, View("responses")], null));
    }

    private static ViewDefinition View(string id) =>
        new(id, id, ViewKind.List, [], null, [], null, null, false);
}
