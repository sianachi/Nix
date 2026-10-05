using Nix.Domain.Primitives;

namespace Nix.Domain.Workers;

/// <summary>Identifies one durable outbox event.</summary>
public readonly record struct WorkerOutboxEventId(Guid Value) : INixId<WorkerOutboxEventId>
{
    /// <inheritdoc />
    public static WorkerOutboxEventId From(Guid value) => new(value);

    /// <inheritdoc />
    public static WorkerOutboxEventId Create() => new(Guid.CreateVersion7());

    /// <inheritdoc />
    public override string ToString() => Value.ToString("D");
}
