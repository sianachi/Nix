using Nix.Abstractions;
using Nix.Domain.Identity;
using Nix.Domain.Primitives;
using Nix.Domain.Tenancy;
using Nix.Messaging;

namespace Nix.Features.Identity;

/// <summary>Completes one already-validated interactive sign-in inside its tenant transaction.</summary>
public sealed record CompleteBrowserSignIn(
    TenantId TenantId,
    string Issuer,
    string Subject,
    UserInfoProfile Profile,
    AuthenticatedPrincipal? ExistingPrincipal,
    BrowserSession Session) : ICommand<CompletedBrowserSignIn>;

/// <summary>The principal and browser session committed by sign-in completion.</summary>
public sealed record CompletedBrowserSignIn(
    AuthenticatedPrincipal Principal,
    BrowserSession Session);

/// <summary>Provisions a missing human and stores their revocable browser session.</summary>
public sealed class CompleteBrowserSignInHandler(
    IPersonalWorkspaceProvisioner provisioner,
    IBrowserSessions browserSessions)
    : ICommandHandler<CompleteBrowserSignIn, CompletedBrowserSignIn>
{
    /// <inheritdoc />
    public async ValueTask<Result<CompletedBrowserSignIn>> HandleAsync(
        CompleteBrowserSignIn command,
        CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(command);
        var principal = command.ExistingPrincipal
            ?? await provisioner.ProvisionAsync(
                command.TenantId,
                command.Issuer,
                command.Subject,
                command.Profile,
                cancellationToken).ConfigureAwait(false);

        if (principal.Status != PrincipalStatus.Active
            || principal.TenantId != command.TenantId
            || principal.Id != command.Session.PrincipalId)
        {
            return Result.Failure<CompletedBrowserSignIn>(
                "auth.session_invariant",
                "The interactive session could not be bound to the active principal.");
        }

        await browserSessions.AddAsync(command.Session, cancellationToken).ConfigureAwait(false);
        return Result.Success(new CompletedBrowserSignIn(principal, command.Session));
    }
}
