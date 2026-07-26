var builder = WebApplication.CreateBuilder(args);
var app = builder.Build();

app.MapGet("/", () => "Hello World!");

app.Run();

/// <summary>Public entry-point marker so integration tests can host the application.</summary>
#pragma warning disable CA1515 // Justification: WebApplicationFactory<Program> requires the entry point to be public for test hosting.
public partial class Program;
#pragma warning restore CA1515
