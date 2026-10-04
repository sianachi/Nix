using Microsoft.AspNetCore.DataProtection;
using Microsoft.Extensions.DependencyInjection.Extensions;
using Nix.Abstractions.Calendar;
using Nix.Abstractions.Scheduling;
using Nix.Features.Internal;
using Nix.Messaging;
using Nix.Persistence.Calendar;

namespace Nix.Features.CalendarSync;

/// <summary>Registers calendar sync (ADR-0052): stores, provider clients, sources and handlers.</summary>
public static class CalendarSyncServiceCollectionExtensions
{
    /// <summary>Adds every calendar sync service. Called from <c>AddNixPersistence</c>.</summary>
    public static IServiceCollection AddNixCalendarSync(this IServiceCollection services)
    {
        ArgumentNullException.ThrowIfNull(services);

        services.AddOptions<CalendarSyncOptions>().BindConfiguration(CalendarSyncOptions.SectionName);
        services.AddOptions<Nix.Authentication.BrowserAuthOptions>();

        // Idempotent beside the host's own AddDataProtection: the key ring (and its persistence
        // path) is the host's; calendar sync only adds its own purposes on top.
        services.AddDataProtection();
        services.TryAddSingleton(TimeProvider.System);

        // [SEC] The one transport every provider call uses: no redirects (a token endpoint that
        // bounced a code or refresh token elsewhere would leak it), no decompression, and no
        // client-wide timeout - each call carries its own ten-second deadline instead.
        services
            .AddHttpClient(CalendarProviderClients.HttpClientName, static client =>
            {
                client.Timeout = Timeout.InfiniteTimeSpan;
                client.DefaultRequestHeaders.Accept.ParseAdd("application/json");
            })
            .ConfigurePrimaryHttpMessageHandler(static () => new HttpClientHandler
            {
                AllowAutoRedirect = false,
                AutomaticDecompression = System.Net.DecompressionMethods.None,
                UseCookies = false,
            });

        services.TryAddSingleton<CalendarProviderSettings>();
        services.TryAddSingleton<CalendarTokenProtector>();
        services.AddSingleton<ICalendarProviderClient, GoogleCalendarProviderClient>();
        services.AddSingleton<ICalendarProviderClient, MicrosoftCalendarProviderClient>();
        services.TryAddSingleton<CalendarProviderClients>();
        services.TryAddSingleton<Nix.Abstractions.IIsolatedUnitOfWork, Nix.Persistence.IsolatedUnitOfWork>();
        services.TryAddSingleton<CalendarAccessTokens>();

        // Cross-tenant discovery for the planner goes through the SECURITY DEFINER finder only;
        // everything else is scoped and runs under the owner's session.
        services.TryAddSingleton<ICalendarLinkFinder, CalendarLinkFinder>();
        services.AddScoped<ICalendarSyncStore, CalendarSyncStore>();
        services.AddScoped<CalendarSyncSupport>();
        services.AddScoped<CalendarSyncFiring>();
        services.AddScoped<CalendarSyncEngine>();
        services.AddScoped<CalendarWorkerGuard>();
        services.AddScoped<ITriggerSource, CalendarPlannedSyncSource>();
        services.AddScoped<ITriggerSource, CalendarDirtySyncSource>();

        services.AddScoped<ICommandHandler<ListCalendarConnections, CalendarConnectionsResponse>, ListCalendarConnectionsHandler>();
        services.AddScoped<ICommandHandler<AuthorizeCalendarConnection, CalendarAuthorization>, AuthorizeCalendarConnectionHandler>();
        services.AddScoped<ICommandHandler<DeleteCalendarConnection, bool>, DeleteCalendarConnectionHandler>();
        services.AddScoped<ICommandHandler<ListExternalCalendars, ExternalCalendarsResponse>, ListExternalCalendarsHandler>();
        services.AddScoped<ICommandHandler<ListCalendarLinks, CalendarLinksResponse>, ListCalendarLinksHandler>();
        services.AddScoped<ICommandHandler<CreateCalendarLink, CalendarLinkResponse>, CreateCalendarLinkHandler>();
        services.AddScoped<ICommandHandler<UpdateCalendarLink, CalendarLinkResponse>, UpdateCalendarLinkHandler>();
        services.AddScoped<ICommandHandler<DeleteCalendarLink, bool>, DeleteCalendarLinkHandler>();
        services.AddScoped<ICommandHandler<ListWorkspaceCalendarLinks, WorkspaceCalendarLinksResponse>, ListWorkspaceCalendarLinksHandler>();
        services.AddScoped<ICommandHandler<UnlinkWorkspaceCalendar, bool>, UnlinkWorkspaceCalendarHandler>();
        services.AddScoped<ICommandHandler<SyncCalendarLink, SyncCalendarLinkResponse>, SyncCalendarLinkHandler>();
        services.AddScoped<ICommandHandler<ListCalendarLinkLog, CalendarSyncLogPageResponse>, ListCalendarLinkLogHandler>();
        return services;
    }

    /// <summary>Logs every configured-but-disabled provider once at startup, with its reason only.</summary>
    public static void LogCalendarProviders(this IServiceProvider services, ILogger logger)
    {
        ArgumentNullException.ThrowIfNull(services);
        ArgumentNullException.ThrowIfNull(logger);
        foreach (var (provider, reason) in services.GetRequiredService<CalendarProviderSettings>().Disabled)
        {
            if (reason != "not_configured")
            {
                CalendarProviderLog.ProviderDisabled(logger, provider, reason);
            }
        }
    }
}
