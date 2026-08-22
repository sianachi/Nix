using Nix.Domain.Properties;

namespace Nix.Tests.Domain.Properties;

/// <summary>
/// What Core can tell about a formula expression without evaluating one.
/// </summary>
/// <remarks>
/// The formula engine is <c>@nix/sheet</c> and stays there, so this reads references and nothing
/// else. The cases below are the ones where "scan for brackets" and "parse the expression" could
/// disagree; its counterpart on the other side is <c>formulaFieldNames</c> in
/// <c>packages/sheet/src/properties.ts</c>, whose own suite asks the same questions of the parser.
/// </remarks>
public sealed class FormulaReferenceTests
{
    [Fact]
    public void An_expression_with_no_references_reads_none()
    {
        Assert.Empty(FormulaReferences.Read("1 + 2 * ROUND(3.14159, 2)"));
    }

    [Fact]
    public void Each_referenced_key_is_read_once_in_the_order_it_appears()
    {
        Assert.Equal(["spent", "budget"], FormulaReferences.Read("[spent] / [budget] + [spent]"));
    }

    [Fact]
    public void A_reference_is_read_without_the_whitespace_around_it()
    {
        // The lexer trims inside the brackets, so a key written with padding is the same key. The
        // two sides disagreeing here would mean Core checking a cycle over a name that never
        // matches the one the engine resolves.
        Assert.Equal(["estimate"], FormulaReferences.Read("[ estimate ] * 2"));
    }

    [Fact]
    public void A_bracket_inside_a_caption_is_text_rather_than_a_reference()
    {
        // Without this the expression below would be read as referring to "done", and a formula
        // property keyed "done" would be refused for a cycle it does not have.
        Assert.Empty(FormulaReferences.Read("""IF(1, "[done]", "")"""));
    }

    [Fact]
    public void A_doubled_quote_inside_a_caption_does_not_end_it()
    {
        // The lexer's own escape. Ending the literal early here would make the rest of the caption
        // scannable, which is how a bracket in text becomes a phantom reference.
        Assert.Empty(FormulaReferences.Read("""CONCATENATE("say ""[hi]"" twice", "")"""));
    }

    [Fact]
    public void An_unclosed_reference_names_nothing()
    {
        // The engine refuses to parse it at all; there is no key here to check a cycle over.
        Assert.Empty(FormulaReferences.Read("[estimate"));
    }

    [Fact]
    public void An_empty_reference_names_nothing()
    {
        Assert.Empty(FormulaReferences.Read("[] + [  ]"));
    }

    [Fact]
    public void A_set_of_formulas_that_flows_one_way_has_no_cycle()
    {
        var formulas = new Dictionary<string, string>(StringComparer.Ordinal)
        {
            ["remaining"] = "[budget] - [spent]",
            ["headroom"] = "[remaining] / [budget]",
        };

        Assert.Null(FormulaReferences.FindCycle(formulas));
    }

    [Fact]
    public void A_formula_that_reads_itself_is_a_cycle()
    {
        var formulas = new Dictionary<string, string>(StringComparer.Ordinal)
        {
            ["total"] = "[total] + 1",
        };

        Assert.Equal("total", FormulaReferences.FindCycle(formulas));
    }

    [Fact]
    public void A_pair_of_formulas_that_read_each_other_is_a_cycle()
    {
        var formulas = new Dictionary<string, string>(StringComparer.Ordinal)
        {
            ["b"] = "[a] + 1",
            ["a"] = "[b] + 1",
        };

        // Ordinally first of the two, so one mistake gets one answer however the dictionary
        // happens to enumerate.
        Assert.Equal("a", FormulaReferences.FindCycle(formulas));
    }

    [Fact]
    public void A_formula_reading_an_ordinary_property_is_not_a_cycle_even_when_the_keys_match()
    {
        // Only formulas are nodes: a stored property is a constant for the length of an
        // evaluation and cannot refer to anything.
        var formulas = new Dictionary<string, string>(StringComparer.Ordinal)
        {
            ["margin"] = "[price] - [cost]",
        };

        Assert.Null(FormulaReferences.FindCycle(formulas));
    }

    [Fact]
    public void Nothing_declared_is_no_cycle()
    {
        Assert.Null(FormulaReferences.FindCycle(new Dictionary<string, string>(StringComparer.Ordinal)));
    }
}
