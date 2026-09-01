using Nix.Domain.Primitives;

namespace Nix.Domain.Workers;

/// <summary>Identifies one durable worker job.</summary>
public readonly record struct WorkerJobId(Guid Value) : INixId<WorkerJobId>
{
    /// <inheritdoc />
    public static WorkerJobId From(Guid value) => new(value);

    /// <inheritdoc />
    public static WorkerJobId Create() => new(Guid.CreateVersion7());

    /// <inheritdoc />
    public override string ToString() => Value.ToString("D");
}
