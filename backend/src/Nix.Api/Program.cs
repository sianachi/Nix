using System.Net;
using System.Threading.RateLimiting;
using Microsoft.AspNetCore.DataProtection;
using Microsoft.AspNetCore.HttpOverrides;
using Nix;
using Nix.Authentication;
using Nix.Errors;
using Nix.Features.Bookmarks;
using Nix.Features.BrowserAuth;
using Nix.Features.Calendar;
using Nix.Features.Canvas;
using Nix.Features.Charts;
using Nix.Features.CurrentUser;
using Nix.Features.DocumentImports;
using Nix.Features.Exports;
using Nix.Features.Files;
using Nix.Features.Graph;
using Nix.Features.Health;
using Nix.Features.Internal;
using Nix.Features.Items;
using Nix.Features.Operations;
using Nix.Features.Permissions;
using Nix.Features.Pets;
using Nix.Features.Plugins;
using Nix.Features.Properties;
using Nix.Features.Query;
using Nix.Features.Recurrence;
using Nix.Features.Roles;
using Nix.Features.Search;
using Nix.Features.TemplateImports;
using Nix.Features.Templates;
using Nix.Features.Tokens;
using Nix.Features.Views;
using Nix.Features.Workspaces;
using Nix.Http;
using Nix.Persistence;
using Nix.Persistence.ObjectStorage;
using Nix.Persistence.RabbitMq;
using Nix.Persistence.Search;
using Nix.Serialization;

const string nixConnectionStringName = "Nix";

var builder = WebApplication.CreateBuilder(args);

// JSON is source-generated, end to end. The reflection-based resolver is removed
// rather than chained behind ours: a response type missing from
// NixJsonSerializerContext must fail loudly instead of quietly costing a
// reflection walk on a request path (engineering plan section 3.2).
// One context per feature, chained. The chain is what lets a feature own its own JSON contract
// instead of every feature appending to one shared file - the same reason routes are registered
// per feature below. Order is irrelevant: a type appears in exactly one context, and the resolver
// walks the chain until something claims it.
//
// Collapsing these into partial declarations of a single context was tried and reverted. The
// compiler does merge attributes across partials, but System.Text.Json's source generator emits a
// file per declaration and collides on hint names ("NixJsonSerializerContext.Boolean.g.cs must be
// unique"), so the generated context never compiles. The chain is not redundancy - it is what the
// generator supports.
builder.Services.ConfigureHttpJsonOptions(options =>
{
    options.SerializerOptions.TypeInfoResolverChain.Clear();
    options.SerializerOptions.TypeInfoResolverChain.Add(NixJsonSerializerContext.Default);
    options.SerializerOptions.TypeInfoResolverChain.Add(HealthJsonContext.Default);
    options.SerializerOptions.TypeInfoResolverChain.Add(WorkspacesJsonContext.Default);
    options.SerializerOptions.TypeInfoResolverChain.Add(ItemsJsonContext.Default);
    options.SerializerOptions.TypeInfoResolverChain.Add(MeJsonContext.Default);
    options.SerializerOptions.TypeInfoResolverChain.Add(StructureJsonContext.Default);
    options.SerializerOptions.TypeInfoResolverChain.Add(PermissionsJsonContext.Default);
    options.SerializerOptions.TypeInfoResolverChain.Add(RolesJsonContext.Default);
    options.SerializerOptions.TypeInfoResolverChain.Add(InternalJsonContext.Default);
    options.SerializerOptions.TypeInfoResolverChain.Add(SearchJsonContext.Default);
    options.SerializerOptions.TypeInfoResolverChain.Add(CanvasJsonContext.Default);
    options.SerializerOptions.TypeInfoResolverChain.Add(PetJsonContext.Default);
    options.SerializerOptions.TypeInfoResolverChain.Add(GraphJsonContext.Default);
    options.SerializerOptions.TypeInfoResolverChain.Add(CalendarJsonContext.Default);
    options.SerializerOptions.TypeInfoResolverChain.Add(RecurrenceJsonContext.Default);
    options.SerializerOptions.TypeInfoResolverChain.Add(QueryJsonContext.Default);
    options.SerializerOptions.TypeInfoResolverChain.Add(ChartJsonContext.Default);
    options.SerializerOptions.TypeInfoResolverChain.Add(BookmarkJsonContext.Default);
    options.SerializerOptions.TypeInfoResolverChain.Add(TemplateJsonContext.Default);
    options.SerializerOptions.TypeInfoResolverChain.Add(TemplateImportsJsonContext.Default);
    options.SerializerOptions.TypeInfoResolverChain.Add(TokensJsonContext.Default);
    options.SerializerOptions.TypeInfoResolverChain.Add(BrowserAuthJsonContext.Default);
    options.SerializerOptions.TypeInfoResolverChain.Add(FilesJsonContext.Default);
    options.SerializerOptions.TypeInfoResolverChain.Add(OperationsJsonContext.Default);
    options.SerializerOptions.TypeInfoResolverChain.Add(DocumentImportsJsonContext.Default);
    options.SerializerOptions.TypeInfoResolverChain.Add(ExportsJsonContext.Default);
    options.SerializerOptions.TypeInfoResolverChain.Add(PluginsJsonContext.Default);
});

// Injected clock: endpoints never read DateTimeOffset.UtcNow directly, so time is
// controllable in tests.
builder.Services.AddSingleton(TimeProvider.System);
builder.Services.AddSingleton<PublicFormTokenService>();
builder.Services.AddNixObjectStorage(builder.Configuration);

// Singleton: it holds the one signing key, and the mint is pure computation over it. Registered
// whether or not persistence is, because the token validator takes it as a dependency and the
// exchange endpoint reports "unconfigured" honestly rather than failing to resolve.
builder.Services.AddSingleton<SelfIssuedTokenService>();

// Interactive OIDC is mediated by Core. The browser receives only an opaque HttpOnly session
// cookie and short-lived Core-signed access tokens, so provider tokens never enter JavaScript.
builder.Services.Configure<BrowserAuthOptions>(
    builder.Configuration.GetSection(BrowserAuthOptions.SectionName));
var dataProtection = builder.Services.AddDataProtection().SetApplicationName("Nix");
var dataProtectionKeysPath = builder.Configuration["Nix:Bff:DataProtectionKeysPath"];
if (!string.IsNullOrWhiteSpace(dataProtectionKeysPath))
{
    dataProtection.PersistKeysToFileSystem(new DirectoryInfo(dataProtectionKeysPath));
}

builder.Services
    .AddHttpClient(BrowserAuthOptions.HttpClientName, static client =>
    {
        client.Timeout = Timeout.InfiniteTimeSpan;
        client.DefaultRequestHeaders.Accept.ParseAdd("application/json");
    })
    .ConfigurePrimaryHttpMessageHandler(static () => new HttpClientHandler
    {
        AllowAutoRedirect = false,
        AutomaticDecompression = System.Net.DecompressionMethods.None,
    });
builder.Services.AddSingleton<OidcMetadataClient>();

// UserInfo is a separate trust boundary from key discovery. Redirects are disabled so a
// registered endpoint cannot bounce a bearer token to another origin; response bodies are read
// with a stricter streamed bound by UserInfoClient itself.
builder.Services
    .AddHttpClient<Nix.Abstractions.IUserInfoClient, UserInfoClient>(client =>
        client.Timeout = Timeout.InfiniteTimeSpan)
    .ConfigurePrimaryHttpMessageHandler(static () => new HttpClientHandler
    {
        AllowAutoRedirect = false,
        AutomaticDecompression = System.Net.DecompressionMethods.None,
    });

// RFC 9457 problem details for every failure the framework produces. Endpoint-owned
// failures build their payload through ApiProblem; this covers the rest and
// guarantees the stable `code` extension is present on both paths.
builder.Services.AddProblemDetails(options =>
    options.CustomizeProblemDetails = context =>
        ApiProblem.Enrich(context.ProblemDetails, context.HttpContext));

// Request bodies are bounded before any payload is copied. Kestrel's default ceiling is 30 MB
// against an API whose largest post-deserialization bound is 32 KB (property bags, view
// definitions).
//
// Be precise about what this buys, because the ceiling is not itself an allocation: Kestrel does
// not reserve 30 MB per request, it bounds how much a client may stream before the read throws.
// What the gap costs is everything downstream of the socket that is sized by what actually arrives
// - the JSON reader's buffering of an incomplete document, and the pooled-buffer copies feeding it.
// At 30 MB those land on the large object heap and stay there until a compacting collection; at
// 256 KB they stay under the 85 KB-per-segment pooling regime this codebase budgets for. So the
// real result is LOH avoidance and a bounded read, not a reclaimed reservation.
//
// 256 KB leaves room for the domain bounds plus JSON escaping and envelope. The one legitimately
// larger payload, the canvas library PUT (stored bound 1 MiB), raises its own ceiling at the route
// via WithRequestBodyLimit.
builder.WebHost.ConfigureKestrel(static options =>
    options.Limits.MaxRequestBodySize = 256 * 1024);

// When Kestrel refuses an oversized body, the read throws BadHttpRequestException carrying 413.
// Left alone, the exception handler would report it as a 500; carrying the exception's own status
// through lets ApiProblem.Enrich stamp the stable request.body_too_large code on the payload.
builder.Services.Configure<ExceptionHandlerOptions>(static options =>
    options.StatusCodeSelector = static exception =>
        exception is BadHttpRequestException badRequest
            ? badRequest.StatusCode
            : StatusCodes.Status500InternalServerError);

// Who the client is, before anything partitions on it. Core is deployed behind a reverse proxy, so
// without this every request carries the proxy's address and both limiters below become one global
// bucket. The allowlist is the whole point and is never widened to "any peer" - see TrustedProxies.
builder.Services.Configure<ForwardedHeadersOptions>(options =>
    TrustedProxies.Configure(options, builder.Configuration));

// Rate limits are baseline hardening, not throttling: bounds a person never meets, a runaway
// client does. Limits read from configuration so a deployment (or the Testing host) can move them
// without a rebuild; the defaults are the policy.
var writesPerMinute = builder.Configuration.GetValue("Nix:RateLimits:WritesPerMinute", 120);
var publicFormSubmissionsPerMinute = builder.Configuration.GetValue(
    "Nix:RateLimits:PublicFormSubmissionsPerMinute",
    20);
var tokenExchangesPerMinute = builder.Configuration.GetValue(
    "Nix:RateLimits:TokenExchangesPerMinute",
    30);

// One window, named once: the limiter's window and the fallback the rejection reports are the same
// interval by definition, and two literals would eventually disagree.
var writesWindow = TimeSpan.FromMinutes(1);
builder.Services.AddRateLimiter(options =>
{
    // Partitioned by remote address, not principal: this middleware runs before
    // NixUnitOfWorkMiddleware has authenticated anyone, so the principal simply is not known at
    // rate-limit time, and running the limiter after authentication would put the expensive part
    // (token validation, a database round trip) inside the unprotected region. An address is what
    // a pre-authentication surface has; the limit is sized so shared NATs do not meet it. The
    // address is the client's own only because UseForwardedHeaders runs ahead of the limiter.
    options.AddPolicy<IPAddress>(RateLimitRefusal.WritesPolicyName, httpContext =>
        RateLimitPartition.GetFixedWindowLimiter(
            ClientKey.For(httpContext),
            _ => new FixedWindowRateLimiterOptions
            {
                PermitLimit = writesPerMinute,
                Window = writesWindow,
                QueueLimit = 0,
            }));

    options.AddPolicy<string>(RateLimitRefusal.PublicFormsPolicyName, httpContext =>
    {
        var token = httpContext.Request.RouteValues["token"]?.ToString() ?? "invalid";
        var tokens = httpContext.RequestServices.GetRequiredService<PublicFormTokenService>();
        var linkKey = tokens.TryRead(token, out var payload)
            ? payload.LinkId.ToString("D")
            : "invalid";
        return RateLimitPartition.GetFixedWindowLimiter(
            $"{ClientKey.For(httpContext)}:{linkKey}",
            _ => new FixedWindowRateLimiterOptions
            {
                PermitLimit = publicFormSubmissionsPerMinute,
                Window = writesWindow,
                QueueLimit = 0,
            });
    });

    // The exchange is unauthenticated by nature and signs a JWT on success, so it carries its own
    // window besides the failed-authentication throttle: guessing is throttled there, and this
    // bounds how fast even a valid token can spend signatures. Per address, like the writes
    // policy and for the same pre-authentication reason.
    options.AddPolicy<IPAddress>(RateLimitRefusal.TokenExchangePolicyName, httpContext =>
        RateLimitPartition.GetFixedWindowLimiter(
            ClientKey.For(httpContext),
            _ => new FixedWindowRateLimiterOptions
            {
                PermitLimit = tokenExchangesPerMinute,
                Window = writesWindow,
                QueueLimit = 0,
            }));

    options.OnRejected = (context, cancellationToken) =>
    {
        var retryAfter = context.Lease.TryGetMetadata(MetadataName.RetryAfter, out var value)
            ? value
            : writesWindow;

        // Information: a client meeting a write limit is a runaway or a burst, not a security
        // event, and one line per refused request at Warning would bury the ones that are.
        var logger = context.HttpContext.RequestServices
            .GetRequiredService<ILoggerFactory>()
            .CreateLogger(RateLimitRefusal.WritesPolicyName);

        return new ValueTask(RateLimitRefusal.WriteAsync(
            context.HttpContext,
            logger,
            RateLimitRefusal.WritesPolicyName,
            retryAfter,
            LogLevel.Information,
            cancellationToken));
    };
});
builder.Services.AddSingleton(_ => new InternalWriteRateLimiter(writesPerMinute, writesWindow));

// Failed-authentication backpressure for the unit-of-work middleware. Registered unconditionally -
// it holds no connection and costs a dictionary - even though only the persistence-configured
// pipeline consults it.
builder.Services.AddSingleton(static provider =>
{
    var configuration = provider.GetRequiredService<IConfiguration>();
    return new FailedAuthenticationThrottle(
        provider.GetRequiredService<TimeProvider>(),
        configuration.GetValue(
            FailedAuthenticationThrottle.LimitConfigurationKey,
            FailedAuthenticationThrottle.DefaultLimit),
        TimeSpan.FromSeconds(configuration.GetValue(
            FailedAuthenticationThrottle.WindowSecondsConfigurationKey,
            (int)FailedAuthenticationThrottle.DefaultWindow.TotalSeconds)));
});

// Persistence, when a connection string is configured.
//
// Three callers depend on this host booting without a database: the endpoint tests, which run the
// real Program to assert the wire contract; the build itself, which starts the host to write
// backend/openapi/nix-api.json; and the frontend lane, which reads that document. None of them
// needs Postgres, and making the contract seam depend on infrastructure would be a poor trade for
// a check that belongs in deployment.
//
// Note the migration is deliberately not run from here; see NixMigrationRunner.
var nixConnectionString = builder.Configuration.GetConnectionString(nixConnectionStringName);
var persistenceConfigured = !string.IsNullOrWhiteSpace(nixConnectionString);
if (persistenceConfigured)
{
    builder.Services.AddNixPersistence(nixConnectionString!);
    builder.Services.AddNixSearch(builder.Configuration);
    builder.Services.AddNixRabbitMq(builder.Configuration);

    // Scoped, because it resolves issuers through the request's own connection. The signing-key
    // cache inside it is static and shared, which is the part that must not be per request.
    builder.Services.AddScoped<NixTokenValidator>();
    builder.Services.AddScoped<BrowserAuthCoordinator>();
}

builder.Services.AddOpenApi(options =>
{
    options.AddDocumentTransformer((document, _, _) =>
    {
        document.Info.Title = "Nix API";
        document.Info.Description =
            "Contract for the Nix collaborative document workspace. "
            + "The generated frontend client and its MSW mocks are built from this document.";
        return Task.CompletedTask;
    });

    // A property bag is a free-form object, and the generator does not know that. Left alone it
    // emits JsonObject as an object declaring no members, which the TypeScript generator faithfully
    // renders as Record<string, never> - a bag that may contain nothing. Every client would then
    // have to cast around its own contract to read a property value, which is the opposite of what
    // publishing a contract is for.
    options.AddSchemaTransformer((schema, context, _) =>
    {
        if (context.JsonTypeInfo.Type == typeof(System.Text.Json.Nodes.JsonObject))
        {
            // An empty schema rather than merely allowing additional properties: OpenAPI 3.1 reads
            // a bare "type": "object" as free-form, but generators do not agree about that, and the
            // TypeScript one takes it as an object with no members. Saying "any value" explicitly
            // leaves nothing to interpret.
            schema.AdditionalPropertiesAllowed = true;
            schema.AdditionalProperties = new Microsoft.OpenApi.OpenApiSchema();
        }

        return Task.CompletedTask;
    });

    options.AddSchemaTransformer((schema, context, _) =>
    {
        if ((context.JsonTypeInfo.Type == typeof(Nix.Features.Workspaces.CreateWorkspaceInvitationRequest)
             || context.JsonTypeInfo.Type == typeof(Nix.Features.Workspaces.ChangeWorkspaceMemberRoleRequest))
            && schema.Properties?.TryGetValue("role", out var role) == true
            && role is Microsoft.OpenApi.OpenApiSchema roleSchema)
        {
            roleSchema.Enum = new List<System.Text.Json.Nodes.JsonNode>
            {
                System.Text.Json.Nodes.JsonValue.Create("owner"),
                System.Text.Json.Nodes.JsonValue.Create("editor"),
                System.Text.Json.Nodes.JsonValue.Create("viewer"),
            };
        }

        return Task.CompletedTask;
    });

    // Constructed rather than resolved: the transformer is stateless and has no
    // dependencies, so DI activation would only hide it from the analyzers.
    options.AddSchemaTransformer(new ProblemDetailsSchemaTransformer());
});

var app = builder.Build();

// Say so, loudly, rather than refusing to start.
//
// Refusing was the first instinct and it is wrong here: the build-time OpenAPI generator drives
// this same file to construct and start the host, so a throw on a missing connection string makes
// generating the contract require a database - coupling the seam between the two development
// lanes to infrastructure neither of them needs. The deployment manifests are where a missing
// connection string should stop a rollout, and a warning at boot is what makes its absence
// visible in the meantime.
if (!persistenceConfigured)
{
    ApiLog.PersistenceNotConfigured(app.Logger, nixConnectionStringName);
}

// First, ahead of everything: the body-limit middleware, the rate limiter and the failed-
// authentication throttle all read Connection.RemoteIpAddress, and this is what makes that the
// client's address rather than the proxy's. Registered before any of them so no refusal is ever
// decided on the wrong identity.
app.UseForwardedHeaders();

// Unhandled exceptions and bare status codes both become problem details, so a
// client only ever has to parse one error shape.
app.UseExceptionHandler();
app.UseStatusCodePages();

// Routing runs first (WebApplication places it at the front of the pipeline), so both of these see
// the matched endpoint: body limits declared per route are applied to the connection before
// anything reads a body, and the writes rate limit refuses over-limit mutations before the
// unit-of-work branch below spends a token validation on them.
app.UseMiddleware<RequestBodyLimitMiddleware>();
app.UseRateLimiter();

// The committed artifact at backend/openapi/nix-api.json is the contract of record;
// this endpoint exists for local exploration only and is not exposed in deployed
// environments.
if (app.Environment.IsDevelopment())
{
    app.MapOpenApi();
}

// Health is deliberately outside the unit of work: a liveness probe that needed a database would
// report the database's health, not the process's, and an orchestrator would restart a healthy
// pod because Postgres was briefly slow.
app.MapHealthEndpoints();

// These routes deliberately sit outside /api/v1. They establish or restore the browser session
// that subsequently obtains a Core bearer token; running the bearer middleware here would make
// login depend on already being logged in.
if (persistenceConfigured)
{
    app.MapBrowserAuthEndpoints();
}

// Everything below this line runs inside a tenant-scoped transaction and requires a bearer token.
if (persistenceConfigured)
{
    app.UseWhen(
        static context =>
            context.Request.Path.StartsWithSegments("/api/v1", StringComparison.OrdinalIgnoreCase)
            && !context.Request.Path.StartsWithSegments(
                "/api/v1/health",
                StringComparison.OrdinalIgnoreCase),
        static branch => branch.UseMiddleware<NixUnitOfWorkMiddleware>());
}

// The service-to-service surface: a shared secret proves the caller is a trusted service, then
// the same unit-of-work pipeline as every public route validates the forwarded user token. The
// boundary middleware runs regardless of persistence so an unconfigured host still answers 404
// rather than reaching a handler with no session behind it.
app.UseWhen(
    static context =>
        context.Request.Path.StartsWithSegments("/internal", StringComparison.OrdinalIgnoreCase),
    branch =>
    {
        branch.UseMiddleware<InternalBoundaryMiddleware>();
        if (persistenceConfigured)
        {
            branch.UseWhen(
                static context => context.Request.Path.StartsWithSegments(
                    "/internal/worker-executions",
                    StringComparison.OrdinalIgnoreCase),
                static executionBranch =>
                {
                    executionBranch.UseMiddleware<Nix.Authentication.WorkerExecutionMiddleware>();
                    executionBranch.UseMiddleware<InternalWriteRateLimitMiddleware>();
                });
            branch.UseWhen(
                static context =>
                    !context.Request.Path.StartsWithSegments(
                        "/internal/worker-dispatch",
                        StringComparison.OrdinalIgnoreCase)
                    && !context.Request.Path.StartsWithSegments(
                        "/internal/worker-executions",
                        StringComparison.OrdinalIgnoreCase),
                static tenantBranch =>
                {
                    tenantBranch.UseMiddleware<NixUnitOfWorkMiddleware>();
                    tenantBranch.UseMiddleware<InternalWriteRateLimitMiddleware>();
                });
        }
    });
if (string.IsNullOrWhiteSpace(app.Configuration[Nix.Authentication.InternalBoundaryMiddleware.SecretConfigurationKey]))
{
    ApiLog.InternalSurfaceDisabled(
        app.Logger,
        Nix.Authentication.InternalBoundaryMiddleware.SecretConfigurationKey);
}

app.MapWorkspaceEndpoints();
app.MapItemEndpoints();
app.MapFileEndpoints();
app.MapDocumentImportEndpoints();
app.MapTemplateImportEndpoints();
app.MapExportEndpoints();
app.MapPluginEndpoints();
app.MapOperationEndpoints();
app.MapMeEndpoints();
app.MapStructureEndpoints();
app.MapPermissionEndpoints();
app.MapRoleEndpoints();
app.MapInternalEndpoints();
app.MapSearchEndpoints();
app.MapCanvasEndpoints();
app.MapPetEndpoints();
app.MapGraphEndpoints();
app.MapCalendarEndpoints();
app.MapRecurrenceEndpoints();
app.MapQueryEndpoints();
app.MapChartEndpoints();
app.MapBookmarkEndpoints();
app.MapPublicFormEndpoints();
app.MapTemplateEndpoints();
app.MapTokenEndpoints();
app.MapTokenExchangeEndpoints();

app.Run();

/// <summary>Public entry-point marker so integration tests can host the application.</summary>
#pragma warning disable CA1515 // Justification: WebApplicationFactory<Program> requires the entry point to be public for test hosting.
public partial class Program;
#pragma warning restore CA1515
