namespace Nix.Abstractions;

/// <summary>
/// Which revocable credential authenticated the unit of work, when it was one a person holds.
/// </summary>
/// <remarks>
/// <para>
/// <b>Why this exists apart from <see cref="NixSessionContext"/>.</b> The session context says
/// <i>who</i> is acting, and that is what permissions are decided on. An item unlock is narrower:
/// it belongs to the browser session or personal access token that presented the password, so that
/// unlocking a note on one screen does not unlock it on every other screen the same person has
/// left signed in. That needs the credential, which the principal does not identify.
/// </para>
/// <para>
/// Only a browser session and a personal access token are recorded. A worker delegation or a raw
/// external token has no credential a person can unlock with, so <see cref="CredentialId"/> stays
/// <see langword="null"/> and a locked body stays closed to it - which is the answer an export
/// worker should get.
/// </para>
/// <para>
/// Set once per scope, by the unit-of-work middleware, for the same reason as the other contexts:
/// a credential that changed mid-request would let later work read under a grant earlier work did
/// not check.
/// </para>
/// </remarks>
public sealed class CredentialSessionContext
{
    private bool _set;

    /// <summary>
    /// Gets the browser session or personal access token identifier, or <see langword="null"/>
    /// when the request was authenticated some other way.
    /// </summary>
    public Guid? CredentialId { get; private set; }

    /// <summary>Records the credential the request authenticated with.</summary>
    /// <param name="credentialId">The browser session or personal access token identifier.</param>
    /// <exception cref="InvalidOperationException">A credential was already recorded.</exception>
    public void Set(Guid credentialId)
    {
        if (_set)
        {
            throw new InvalidOperationException(
                "The credential is already recorded for this scope and is write-once.");
        }

        if (credentialId == Guid.Empty)
        {
            throw new ArgumentException("A credential identifier cannot be empty.", nameof(credentialId));
        }

        _set = true;
        CredentialId = credentialId;
    }
}
