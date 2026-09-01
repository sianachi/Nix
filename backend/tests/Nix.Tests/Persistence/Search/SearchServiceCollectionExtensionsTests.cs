using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Nix.Abstractions;
using Nix.Persistence;
using Nix.Persistence.Search;

namespace Nix.Tests.Persistence.Search;

public sealed class SearchServiceCollectionExtensionsTests
{
    private const string RuntimeConnectionString =
        "Host=localhost;Database=nix;Username=nix_app;Password=x";

    [Fact]
    public void Postgres_remains_the_default_search_provider()
    {
        var services = new ServiceCollection();
        services.AddNixPersistence(RuntimeConnectionString);
        services.AddNixSearch(Configuration([]));

        using var provider = services.BuildServiceProvider(validateScopes: true);
        using var scope = provider.CreateScope();

        Assert.IsType<ItemSearch>(scope.ServiceProvider.GetRequiredService<IItemSearch>());
    }

    [Fact]
    public void Explicit_feature_flag_replaces_only_the_search_port()
    {
        var services = new ServiceCollection();
        services.AddNixPersistence(RuntimeConnectionString);
        services.AddNixSearch(Configuration(
        [
            new("Nix:Search:OpenSearchEnabled", "true"),
            new("Nix:Search:OpenSearchUrl", "https://search.example.test/"),
            new("Nix:Search:OpenSearchIndex", "nix-items"),
        ]));

        using var provider = services.BuildServiceProvider(validateScopes: true);
        using var scope = provider.CreateScope();

        Assert.IsType<OpenSearchItemSearch>(scope.ServiceProvider.GetRequiredService<IItemSearch>());
        Assert.IsType<ItemSearch>(scope.ServiceProvider.GetRequiredService<ItemSearch>());
    }

    [Theory]
    [InlineData("ftp://search.example.test", "nix-items", "2000")]
    [InlineData("https://user:secret@search.example.test", "nix-items", "2000")]
    [InlineData("https://search.example.test", "Nix-*", "2000")]
    [InlineData("https://search.example.test", "nix-items", "0")]
    public void Enabled_provider_refuses_unsafe_or_unbounded_configuration(
        string endpointText,
        string index,
        string timeout)
    {
        var services = new ServiceCollection();
        services.AddNixPersistence(RuntimeConnectionString);
        var configuration = Configuration(
        [
            new("Nix:Search:OpenSearchEnabled", "true"),
            new("Nix:Search:OpenSearchUrl", endpointText),
            new("Nix:Search:OpenSearchIndex", index),
            new("Nix:Search:TimeoutMilliseconds", timeout),
        ]);

        Assert.Throws<InvalidOperationException>(() => services.AddNixSearch(configuration));
    }

    private static IConfiguration Configuration(
        IEnumerable<KeyValuePair<string, string?>> values) =>
        new ConfigurationBuilder().AddInMemoryCollection(values).Build();
}
