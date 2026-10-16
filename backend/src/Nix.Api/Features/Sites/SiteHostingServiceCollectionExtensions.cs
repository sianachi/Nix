using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;
using Nix.Abstractions;
using Nix.Domain.Primitives;
using Nix.Messaging;
using Nix.Persistence.Sites;

namespace Nix.Features.Sites;

/// <summary>Registers site hostnames, DNS automation and first-publish approval (ADR-0063 M5).</summary>
public static class SiteHostingServiceCollectionExtensions
{
    /// <summary>Adds the hosting services. Expects <see cref="SiteOptions"/> to be registered.</summary>
    public static IServiceCollection AddSiteHosting(this IServiceCollection services)
    {
        ArgumentNullException.ThrowIfNull(services);

        services.AddHttpClient(DohSiteDnsResolver.HttpClientName, static client => client.Timeout = TimeSpan.FromSeconds(5));
        services.AddHttpClient(CloudflareDnsClient.HttpClientName, static client => client.Timeout = TimeSpan.FromSeconds(10));
        services.TryAddSingleton<ISiteDnsResolver>(static provider => new DohSiteDnsResolver(
            provider.GetRequiredService<IHttpClientFactory>().CreateClient(DohSiteDnsResolver.HttpClientName),
            provider.GetRequiredService<SiteOptions>().DnsResolverUrl));
        services.TryAddSingleton<ICloudflareDns>(static provider =>
        {
            var cloudflare = provider.GetRequiredService<SiteOptions>().Cloudflare;
            return new CloudflareDnsClient(
                provider.GetRequiredService<IHttpClientFactory>().CreateClient(CloudflareDnsClient.HttpClientName),
                cloudflare.ApiToken,
                cloudflare.AccountId,
                cloudflare.TunnelId);
        });
        services.TryAddSingleton<IIsolatedUnitOfWork, Nix.Persistence.IsolatedUnitOfWork>();
        services.AddSingleton<ISiteHostnameCheckCandidates, SiteHostnameCheckFinder>();
        services.AddScoped<SiteHostnameStore>();
        services.AddScoped<ISiteHostnameStore>(static provider => provider.GetRequiredService<SiteHostnameStore>());
        services.AddScoped<ISiteTunnelLock>(static provider => provider.GetRequiredService<SiteHostnameStore>());
        services.AddScoped<SiteHostnameChecker>();
        services.AddScoped<SiteHostnameProvisioner>();
        services.AddScoped<SiteHostnameService>();
        services.AddScoped<SiteOperators>();
        services.AddScoped<Nix.Abstractions.Scheduling.ITriggerSource, SiteHostnameCheckTriggerSource>();
        services.AddScoped<SiteHostnameHandlers>();
        services.AddScoped<ICommandHandler<AddSiteHostname, SiteResponse>>(static provider => provider.GetRequiredService<SiteHostnameHandlers>());
        services.AddScoped<ICommandHandler<RemoveSiteHostname, SiteResponse>>(static provider => provider.GetRequiredService<SiteHostnameHandlers>());
        services.AddScoped<ICommandHandler<UpdateSiteHostname, SiteResponse>>(static provider => provider.GetRequiredService<SiteHostnameHandlers>());
        services.AddScoped<ICommandHandler<VerifySiteHostname, SiteResponse>>(static provider => provider.GetRequiredService<SiteHostnameHandlers>());
        services.AddScoped<SiteApprovalHandlers>();
        services.AddScoped<ICommandHandler<RequestSiteApproval, SiteResponse>>(static provider => provider.GetRequiredService<SiteApprovalHandlers>());
        services.AddScoped<IQueryHandler<ListSiteApprovals, Result<SiteApprovalListResponse>>>(static provider => provider.GetRequiredService<SiteApprovalHandlers>());
        services.AddScoped<ICommandHandler<ApproveSitePublish, SiteApprovalResponse>>(static provider => provider.GetRequiredService<SiteApprovalHandlers>());
        services.AddScoped<ICommandHandler<RejectSitePublish, SiteApprovalResponse>>(static provider => provider.GetRequiredService<SiteApprovalHandlers>());
        services.AddScoped<SiteOperatorHandlers>();
        services.AddScoped<IQueryHandler<ListSiteOperators, Result<SiteOperatorListResponse>>>(static provider => provider.GetRequiredService<SiteOperatorHandlers>());
        services.AddScoped<ICommandHandler<GrantSiteOperator, Guid>>(static provider => provider.GetRequiredService<SiteOperatorHandlers>());
        services.AddScoped<ICommandHandler<RevokeSiteOperator, Guid>>(static provider => provider.GetRequiredService<SiteOperatorHandlers>());
        return services;
    }
}
