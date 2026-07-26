using Nix.Api.Errors;
using Nix.Api.Features.Health;
using Nix.Api.Serialization;

var builder = WebApplication.CreateBuilder(args);

// JSON is source-generated, end to end. The reflection-based resolver is removed
// rather than chained behind ours: a response type missing from
// NixJsonSerializerContext must fail loudly instead of quietly costing a
// reflection walk on a request path (engineering plan section 3.2).
builder.Services.ConfigureHttpJsonOptions(options =>
{
    options.SerializerOptions.TypeInfoResolverChain.Clear();
    options.SerializerOptions.TypeInfoResolverChain.Add(NixJsonSerializerContext.Default);
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

app.MapHealthEndpoints();

app.Run();

/// <summary>Public entry-point marker so integration tests can host the application.</summary>
#pragma warning disable CA1515 // Justification: WebApplicationFactory<Program> requires the entry point to be public for test hosting.
public partial class Program;
#pragma warning restore CA1515
