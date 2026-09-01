using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;
using Nix.Abstractions;

namespace Nix.Persistence.Search;

/// <summary>Registers the optional OpenSearch read path behind an explicit feature flag.</summary>
public static class SearchServiceCollectionExtensions
{
    /// <summary>
    /// Leaves Postgres active by default and replaces only ranked text search when enabled.
    /// </summary>
    public static IServiceCollection AddNixSearch(
        this IServiceCollection services,
        IConfiguration configuration)
    {
        ArgumentNullException.ThrowIfNull(services);
        ArgumentNullException.ThrowIfNull(configuration);

        var options = new SearchProviderOptions();
        configuration.GetSection(SearchProviderOptions.SectionName).Bind(options);
        if (!options.OpenSearchEnabled)
        {
            return services;
        }

        Validate(options);
        services.AddSingleton(options);
        services
            .AddHttpClient(SearchProviderOptions.HttpClientName, client =>
            {
                client.BaseAddress = options.OpenSearchUrl;
                client.Timeout = Timeout.InfiniteTimeSpan;
            })
            .ConfigurePrimaryHttpMessageHandler(static () => new HttpClientHandler
            {
                AllowAutoRedirect = false,
                AutomaticDecompression = System.Net.DecompressionMethods.None,
            });
        services.AddScoped(provider => new OpenSearchItemQueryClient(
            provider.GetRequiredService<IHttpClientFactory>()
                .CreateClient(SearchProviderOptions.HttpClientName),
            provider.GetRequiredService<INixSessionContextAccessor>(),
            options.OpenSearchIndex,
            TimeSpan.FromMilliseconds(options.TimeoutMilliseconds)));
        services.Replace(ServiceDescriptor.Scoped<IItemSearch, OpenSearchItemSearch>());
        return services;
    }

    private static void Validate(SearchProviderOptions options)
    {
        var origin = options.OpenSearchUrl;
        if (origin is null
            || !origin.IsAbsoluteUri
            || origin.Scheme is not ("http" or "https")
            || origin.UserInfo.Length != 0
            || origin.Query.Length != 0
            || origin.Fragment.Length != 0)
        {
            throw new InvalidOperationException(
                "Nix:Search:OpenSearchUrl must be an absolute HTTP origin without credentials, query, or fragment.");
        }

        if (options.TimeoutMilliseconds is < 1 or > 30000)
        {
            throw new InvalidOperationException(
                "Nix:Search:TimeoutMilliseconds must be between 1 and 30000.");
        }

        try
        {
            OpenSearchItemQueryClient.ValidateIndexName(options.OpenSearchIndex);
        }
        catch (ArgumentException exception)
        {
            throw new InvalidOperationException(
                "Nix:Search:OpenSearchIndex must be an exact safe index or alias name.",
                exception);
        }
    }
}
