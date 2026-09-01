using Nix.Domain.Primitives;

namespace Nix.Domain.Importing;

/// <summary>Identifies one durable document import protocol.</summary>
public readonly record struct DocumentImportId(Guid Value) : INixId<DocumentImportId>
{
    public static DocumentImportId From(Guid value) => new(value);

    public static DocumentImportId Create() => new(Guid.CreateVersion7());

    public override string ToString() => Value.ToString("D");
}
