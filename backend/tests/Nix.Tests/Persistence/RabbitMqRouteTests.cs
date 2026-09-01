using Nix.Abstractions.Workers;
using Nix.Persistence.RabbitMq;

namespace Nix.Tests.Persistence;

public sealed class RabbitMqRouteTests
{
    [Fact]
    public void Worker_commands_route_by_the_authoritative_job_kind()
    {
        var jobId = Guid.Parse("10000000-0000-4000-8000-000000000001");
        var route = RabbitMqRoute.For(Event(
            RabbitMqNames.WorkerCommandKind,
            $$"""{"jobId":"{{jobId:D}}","kind":"import.pdf"}"""));

        Assert.Equal(RabbitMqNames.CommandsExchange, route.Exchange);
        Assert.Equal("import.pdf", route.RoutingKey);
        Assert.Equal("worker.command.v1", route.MessageType);
        Assert.Equal(jobId.ToString("D"), route.CorrelationId);
    }

    [Fact]
    public void Workspace_events_route_without_exposing_their_payload()
    {
        var source = Event("item.changed", "{\"itemId\":\"opaque\"}");

        var route = RabbitMqRoute.For(source);

        Assert.Equal(RabbitMqNames.WorkspaceExchange, route.Exchange);
        Assert.Equal("item.changed", route.RoutingKey);
        Assert.Equal(source.Id.ToString("D"), route.CorrelationId);
    }

    [Fact]
    public void Invalid_worker_command_references_fail_closed()
    {
        var source = Event(RabbitMqNames.WorkerCommandKind, "{\"jobId\":\"not-a-guid\",\"kind\":\"import.pdf\"}");

        Assert.Throws<InvalidOperationException>(() => RabbitMqRoute.For(source));
    }

    private static DispatchedOutboxEvent Event(string kind, string payload) => new(
        Guid.Parse("20000000-0000-4000-8000-000000000001"),
        Guid.Parse("30000000-0000-4000-8000-000000000001"),
        Guid.Parse("40000000-0000-4000-8000-000000000001"),
        null,
        kind,
        payload,
        1,
        DateTimeOffset.Parse("2026-08-31T20:00:00Z", System.Globalization.CultureInfo.InvariantCulture));
}
