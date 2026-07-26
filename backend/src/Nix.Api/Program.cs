using Nix.Api;
using Nix.Api.Authentication;
using Nix.Api.Errors;
using Nix.Api.Features.Health;
using Nix.Api.Features.Items;
using Nix.Api.Features.Me;
using Nix.Api.Features.Permissions;
using Nix.Api.Features.Roles;
using Nix.Api.Features.Workspaces;
using Nix.Api.Serialization;
using Nix.Infrastructure.Persistence;

const string NixConnectionStringName = "Nix";

var builder = WebApplication.CreateBuilder(args);

// JSON is source-generated, end to end. The reflection-based resolver is removed
// rather than chained behind ours: a response type missing from
// NixJsonSerializerContext must fail loudly instead of quietly costing a
// reflection walk on a request path (engineering plan section 3.2).
// One context per feature, chained. The chain is what lets a feature own its own JSON contract
// instead of every feature appending to one shared file - the same reason routes are registered
// per feature below. Order is irrelevant: a type appears in exactly one context, and the resolver
// walks the chain until something claims it.
builder.Services.ConfigureHttpJsonOptions(options =>
{
    options.SerializerOptions.TypeInfoResolverChain.Clear();
    options.SerializerOptions.TypeInfoResolverChain.Add(NixJsonSerializerContext.Default);
    options.SerializerOptions.TypeInfoResolverChain.Add(HealthJsonContext.Default);
    options.SerializerOptions.TypeInfoResolverChain.Add(WorkspacesJsonContext.Default);
    options.SerializerOptions.TypeInfoResolverChain.Add(ItemsJsonContext.Default);
    options.SerializerOptions.TypeInfoResolverChain.Add(MeJsonContext.Default);
    options.SerializerOptions.TypeInfoResolverChain.Add(PermissionsJsonContext.Default);
    options.SerializerOptions.TypeInfoResolverChain.Add(RolesJsonContext.Default);
});

// Injected clock: endpoints never read DateTimeOffset.UtcNow directly, so time is
// controllable in tests.
builder.Services.AddSingleton(TimeProvider.System);

// RFC 9457 problem details for every failure the framework produces. Endpoint-owned
// failures build their payload through ApiProblem; this covers the rest and
// guarantees the stable `code` extension is present on both paths.
builder.Services.AddProblemDetails(options =>
    options.CustomizeProblemDetails = context =>
        ApiProblem.Enrich(context.ProblemDetails, context.HttpContext));

// Persistence, when a connection string is configured.
//
// Three callers depend on this host booting without a database: the endpoint tests, which run the
// real Program to assert the wire contract; the build itself, which starts the host to write
// backend/openapi/nix-api.json; and the frontend lane, which reads that document. None of them
// needs Postgres, and making the contract seam depend on infrastructure would be a poor trade for
// a check that belongs in deployment.
//
// Note the migration is deliberately not run from here; see NixMigrationRunner.
var nixConnectionString = builder.Configuration.GetConnectionString(NixConnectionStringName);
var persistenceConfigured = !string.IsNullOrWhiteSpace(nixConnectionString);
if (persistenceConfigured)
{
    builder.Services.AddNixPersistence(nixConnectionString!);

    // Scoped, because it resolves issuers through the request's own connection. The signing-key
    // cache inside it is static and shared, which is the part that must not be per request.
    builder.Services.AddScoped<NixTokenValidator>();
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
    ApiLog.PersistenceNotConfigured(app.Logger, NixConnectionStringName);
}

// Unhandled exceptions and bare status codes both become problem details, so a
// client only ever has to parse one error shape.
app.UseExceptionHandler();
app.UseStatusCodePages();

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
app.MapWorkspaceEndpoints();
app.MapItemEndpoints();
app.MapMeEndpoints();
app.MapPermissionEndpoints();
app.MapRoleEndpoints();

app.Run();

/// <summary>Public entry-point marker so integration tests can host the application.</summary>
#pragma warning disable CA1515 // Justification: WebApplicationFactory<Program> requires the entry point to be public for test hosting.
public partial class Program;
#pragma warning restore CA1515
