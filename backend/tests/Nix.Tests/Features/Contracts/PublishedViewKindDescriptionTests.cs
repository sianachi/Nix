using Microsoft.AspNetCore.Http.Metadata;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.AspNetCore.Routing;
using Microsoft.Extensions.DependencyInjection;
using Nix.Domain.Views;
using Nix.Features.Views;
using Nix.Tests.Harness;

namespace Nix.Tests.Features.Contracts;

/// <summary>
/// What the published contract says about a view's kind.
/// </summary>
/// <remarks>
/// <para>
/// Why these sentences are generated rather than typed is recorded once, on
/// <see cref="ViewKindProse"/>, and is not repeated here.
/// </para>
/// <para>
/// These tests rebuild the expected wording from <see cref="ViewKinds.All"/>, independently of the
/// code that publishes it, so replacing a generator with a literal fails here rather than shipping.
/// Every clause that names kinds is covered: a clause left hand-written beside a generated one is
/// worse than none of them being generated, because the suite would then pass while the contract
/// went stale.
/// </para>
/// <para>
/// The descriptions are read off the registered endpoints rather than off the committed document:
/// the endpoint metadata is what the generator reads, so it is the earliest place the drift is
/// visible, and it needs neither a database nor the OpenAPI route.
/// </para>
/// </remarks>
public sealed class PublishedViewKindDescriptionTests(ContractHostFactory factory)
    : IClassFixture<ContractHostFactory>
{
    [Fact]
    public void The_published_description_names_every_view_kind_this_build_defines()
    {
        var kinds = ViewKinds.All.Select(descriptor => descriptor.Text).ToArray();

        Assert.Contains(
            $"A view's kind is one of {Quoted(kinds, " or ")}.",
            DescriptionOf("SetContainerViews"),
            StringComparison.Ordinal);
    }

    [Fact]
    public void The_published_description_says_what_every_kind_that_needs_a_property_must_be_given()
    {
        // The clause that shares a string literal with the one above. It enumerated two kinds by
        // hand and omitted the third, which is the drift these tests exist to catch - and a
        // hand-written clause beside a generated one is the case a green suite would hide.
        var clauses = ViewKinds
            .All.Where(descriptor => descriptor.Requirement is not null)
            .Select(descriptor => descriptor.Requirement!.Missing)
            .ToArray();

        Assert.Contains(
            $"What a kind must name is checked here ({Sentence(clauses, " and ")}), but whether "
                + "that property exists is not",
            DescriptionOf("SetContainerViews"),
            StringComparison.Ordinal);
    }

    [Fact]
    public void The_published_description_names_every_view_kind_that_can_always_be_drawn()
    {
        // A kind with no requirement needs nothing from the schema, so it can never be reported as
        // unrenderable - which is a promise the read endpoint makes to a client, and one a new
        // requirement-free kind would otherwise quietly make untrue.
        var kinds = ViewKinds
            .All.Where(descriptor => descriptor.Requirement is null)
            .Select(descriptor => descriptor.Text)
            .ToArray();

        Assert.Contains(
            $"A kind that needs nothing from the schema ({Quoted(kinds, " and ")}) is never "
                + "listed there",
            DescriptionOf("GetContainerViews"),
            StringComparison.Ordinal);
    }

    [Fact]
    public void One_part_joins_to_itself()
    {
        Assert.Equal("'list'", ViewKindProse.JoinQuoted(["list"], " or "));
        Assert.Equal("a board needs one", ViewKindProse.Join(["a board needs one"], " and "));
    }

    [Fact]
    public void Two_parts_are_joined_by_the_final_separator_alone()
    {
        Assert.Equal("'list' or 'board'", ViewKindProse.JoinQuoted(["list", "board"], " or "));
        Assert.Equal("one and two", ViewKindProse.Join(["one", "two"], " and "));
    }

    [Fact]
    public void Three_parts_take_commas_and_then_the_final_separator()
    {
        Assert.Equal(
            "'list', 'board' or 'calendar'",
            ViewKindProse.JoinQuoted(["list", "board", "calendar"], " or "));
        Assert.Equal("one, two and three", ViewKindProse.Join(["one", "two", "three"], " and "));
    }

    [Fact]
    public void No_parts_join_to_nothing()
    {
        // Not a hypothetical: a kind can be retired as readily as added, and the sentences around
        // these lists must not assume there is anything in them.
        Assert.Equal(string.Empty, ViewKindProse.Join([], " or "));
        Assert.Equal(string.Empty, ViewKindProse.JoinQuoted([], " and "));
    }

    /// <summary>Quotes and joins kind names the way prose does.</summary>
    /// <param name="kinds">The kind names, in table order.</param>
    /// <param name="finalSeparator">What joins the last two.</param>
    /// <returns>The quoted, joined list.</returns>
    private static string Quoted(string[] kinds, string finalSeparator) =>
        Sentence(kinds.Select(kind => $"'{kind}'").ToArray(), finalSeparator);

    /// <summary>Joins clauses the way prose does, rebuilt here rather than shared.</summary>
    /// <param name="parts">The clauses, in table order.</param>
    /// <param name="finalSeparator">What joins the last two.</param>
    /// <returns>The joined list.</returns>
    private static string Sentence(string[] parts, string finalSeparator) =>
        parts.Length < 2
            ? string.Concat(parts)
            : string.Join(", ", parts[..^1]) + finalSeparator + parts[^1];

    /// <summary>Reads the description a named route publishes.</summary>
    /// <param name="endpointName">The route's name.</param>
    /// <returns>The description the OpenAPI generator will copy.</returns>
    private string DescriptionOf(string endpointName)
    {
        var endpoint = factory
            .Services.GetRequiredService<EndpointDataSource>()
            .Endpoints.Single(candidate =>
                string.Equals(
                    candidate.Metadata.GetMetadata<IEndpointNameMetadata>()?.EndpointName,
                    endpointName,
                    StringComparison.Ordinal));

        var description = endpoint.Metadata.GetMetadata<IEndpointDescriptionMetadata>()?.Description;

        Assert.NotNull(description);
        return description;
    }
}
