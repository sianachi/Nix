namespace Nix.Api.Features.Me;

/// <summary>
/// The signed-in caller, as the API presents them to themselves.
/// </summary>
/// <param name="Id">Their principal identifier.</param>
/// <param name="TenantId">The tenant they are acting in.</param>
/// <param name="DisplayName">Their name, for the shell.</param>
/// <param name="Email">Their email address, or <see langword="null"/> when the provider supplies none.</param>
/// <param name="IsTenantAdministrator">Whether tenant-wide administrative surfaces apply to them.</param>
/// <remarks>
/// <para>
/// <b><see cref="IsTenantAdministrator"/> is a display hint and nothing more.</b> It tells the shell
/// whether to offer administrative entries; it does not grant access to anything. Every endpoint
/// behind those entries answers the same question for itself against the database, so a client that
/// set this flag locally would gain a menu item and no capability whatsoever.
/// </para>
/// <para>
/// A boolean rather than a list of roles, because one is what the interface needs and the other
/// invites clients to compute permissions - which they must never do. When the interface needs
/// finer answers they will arrive as named capabilities the server has already decided, not as
/// role names for a client to interpret.
/// </para>
/// </remarks>
internal sealed record CurrentPrincipalResponse(
    Guid Id,
    Guid TenantId,
    string DisplayName,
    string? Email,
    bool IsTenantAdministrator);
