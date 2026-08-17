namespace Nix.Features.Tokens;

/// <summary>What a caller supplies to mint a personal access token.</summary>
/// <param name="Name">What the token is for, so the list reads as intentions.</param>
/// <param name="Scopes">
/// The ceiling, from <c>read</c>, <c>write</c>, <c>admin</c>. At least one; independent, not
/// ordered.
/// </param>
/// <param name="ExpiresInDays">
/// How long it lives, 1 to 365. Required: a token without an end a person chose is the failure
/// mode this whole surface exists to avoid.
/// </param>
public sealed record CreateAccessTokenRequest(
    string? Name,
    IReadOnlyList<string>? Scopes,
    int? ExpiresInDays);

/// <summary>One token row, as the list and the create response describe it. Never the secret.</summary>
/// <param name="Id">The row's identity - names it for revocation, opens nothing.</param>
/// <param name="Name">What the issuer called it.</param>
/// <param name="Scopes">The ceiling it holds.</param>
/// <param name="CreatedAt">When it was issued.</param>
/// <param name="ExpiresAt">When it stops working.</param>
/// <param name="RevokedAt">When it was revoked, or null while it stands.</param>
/// <param name="LastUsedAt">
/// When it last authenticated a request that then <i>succeeded</i>, coarsened to a few minutes;
/// null until the first such use. Recorded inside the request transaction, so a request that
/// fails after authenticating (a 404, a scope refusal) rolls the timestamp back with it - a token
/// probing endpoints it may not reach can therefore still read as null here. Treat it as "last
/// seen working", not proof a null token is dead.
/// </param>
public sealed record AccessTokenResponse(
    Guid Id,
    string Name,
    IReadOnlyList<string> Scopes,
    DateTimeOffset CreatedAt,
    DateTimeOffset ExpiresAt,
    DateTimeOffset? RevokedAt,
    DateTimeOffset? LastUsedAt);

/// <summary>The caller's tokens, newest first, revoked and expired included.</summary>
/// <param name="Tokens">Every token they have issued that has not been purged.</param>
public sealed record AccessTokenListResponse(IReadOnlyList<AccessTokenResponse> Tokens);

/// <summary>The one response that ever carries the secret.</summary>
/// <param name="Token">
/// The full token string. Shown here and never again - only its hash is stored, so there is no
/// second read.
/// </param>
/// <param name="Details">The row, as every later list will describe it.</param>
public sealed record CreatedAccessTokenResponse(string Token, AccessTokenResponse Details);

/// <summary>What a non-browser client presents to buy a short-lived session.</summary>
/// <param name="Token">The personal access token string.</param>
public sealed record TokenExchangeRequest(string? Token);

/// <summary>A bought session: the JWT every Nix service accepts, and how long it lasts.</summary>
/// <param name="AccessToken">The compact JWT to present as a bearer token.</param>
/// <param name="TokenType">Always <c>Bearer</c>.</param>
/// <param name="ExpiresInSeconds">
/// How long the JWT lives. Exchange again before it runs out; the personal access token itself
/// lives until its chosen expiry or revocation.
/// </param>
public sealed record TokenExchangeResponse(
    string AccessToken,
    string TokenType,
    long ExpiresInSeconds);
