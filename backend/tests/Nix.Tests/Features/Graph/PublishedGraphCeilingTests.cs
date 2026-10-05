using System.Globalization;
using Microsoft.AspNetCore.Http.Metadata;
using Microsoft.AspNetCore.Routing;
using Microsoft.Extensions.DependencyInjection;
using Nix.Features.Graph;
using Nix.Tests.Harness;

namespace Nix.Tests.Features.Graph;

/// <summary>
/// What the published contract says about the graph's ceilings.
/// </summary>
/// <remarks>
/// A bounded response is only honest if the bound is written down where a client integrating
/// against the contract will read it. These tests rebuild the expected numbers from the handler's
/// own constants, so raising a ceiling and leaving the prose behind fails here rather than shipping
/// a document that describes the previous release.
/// </remarks>
public sealed class PublishedGraphCeilingTests(ContractHostFactory factory)
    : IClassFixture<ContractHostFactory>
{
    [Fact]
    public void The_published_description_names_the_ceilings_this_build_applies()
    {
        var nodes = GetWorkspaceGraphHandler.MaximumNodes.ToString("N0", CultureInfo.InvariantCulture);
        var links = GetWorkspaceGraphHandler.MaximumLinks.ToString("N0", CultureInfo.InvariantCulture);

        Assert.Contains(
            $"bounded at {nodes} nodes and {links} links",
            DescriptionOf("GetWorkspaceGraph"),
            StringComparison.Ordinal);
    }

    [Fact]
    public void The_published_description_says_truncation_is_reported_in_the_payload()
    {
        // A drawing cannot show that it is partial. The flags are the contract's answer to that,
        // so the sentence naming them is part of the surface rather than commentary on it.
        var description = DescriptionOf("GetWorkspaceGraph");

        Assert.Contains("nodesTruncated", description, StringComparison.Ordinal);
        Assert.Contains("linksTruncated", description, StringComparison.Ordinal);
    }

    [Fact]
    public void The_published_description_says_an_unreadable_item_is_absent_rather_than_redacted()
    {
        Assert.Contains(
            "absent from the nodes, absent from every link, and absent from the counts",
            DescriptionOf("GetWorkspaceGraph"),
            StringComparison.Ordinal);
    }

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
