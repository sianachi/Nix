using Nix.Features.Notifications;

namespace Nix.Tests.Features.Notifications;

public sealed class NotificationWatchGateTests
{
    [Fact]
    public void A_third_concurrent_watch_for_the_same_principal_is_refused()
    {
        var gate = new NotificationWatchGate();
        var principal = Guid.NewGuid();
        Assert.True(gate.TryEnter(principal));
        Assert.True(gate.TryEnter(principal));
        Assert.False(gate.TryEnter(principal));

        gate.Exit(principal);
        Assert.True(gate.TryEnter(principal));
    }

    [Fact]
    public void Different_principals_do_not_share_a_slot()
    {
        var gate = new NotificationWatchGate();
        var first = Guid.NewGuid();
        var second = Guid.NewGuid();
        Assert.True(gate.TryEnter(first));
        Assert.True(gate.TryEnter(first));
        Assert.True(gate.TryEnter(second));
    }

    [Fact]
    public void Exit_is_a_no_op_once_the_count_reaches_zero()
    {
        var gate = new NotificationWatchGate();
        var principal = Guid.NewGuid();
        gate.Exit(principal);
        Assert.True(gate.TryEnter(principal));
    }
}
