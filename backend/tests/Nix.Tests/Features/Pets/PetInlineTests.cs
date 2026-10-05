using Nix.Features.Pets;
namespace Nix.Tests.Features.Pets;

public sealed class PetInlineTests
{
    private static PetInlineRequest Request => new(Guid.NewGuid(), Guid.NewGuid(), Guid.NewGuid(), "improve", "Selected text");
    [Fact]
    public void Validation_bounds_UTF8_bytes_and_requires_material()
    {
        Assert.Null(PetInlineValidation.Check(Request));
        Assert.NotNull(PetInlineValidation.Check(Request with { Selection = new string('文', 6000) }));
        Assert.NotNull(PetInlineValidation.Check(Request with { Selection = "" }));
        Assert.NotNull(PetInlineValidation.Check(Request with { Selection = "\ud800" }));
        Assert.NotNull(PetInlineValidation.Check(Request with { Kind = "custom", Instruction = " " }));
        Assert.NotNull(PetInlineValidation.Check(Request with { Kind = "translate", Language = "English; run tools" }));
        Assert.Null(PetInlineValidation.Check(Request with { Kind = "translate", Language = "French" }));
    }
    [Fact]
    public void Slots_are_isolated_by_principal_and_released_once()
    {
        var limiter = new PetInlineLimiter();
        var principal = Guid.NewGuid();
        using var first = limiter.TryAcquire(principal);
        using var second = limiter.TryAcquire(principal);
        Assert.NotNull(first);
        Assert.NotNull(second);
        Assert.Null(limiter.TryAcquire(principal));
        using var other = limiter.TryAcquire(Guid.NewGuid());
        Assert.NotNull(other);
        first.Dispose();
        first.Dispose();
        using var replacement = limiter.TryAcquire(principal);
        Assert.NotNull(replacement);
        Assert.Null(limiter.TryAcquire(principal));
    }
}
