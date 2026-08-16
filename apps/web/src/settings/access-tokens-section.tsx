import { Button, Dialog, Table, Tag, Text } from '@nix/ui';
import { useState, type ReactElement, type ReactNode } from 'react';

import { ErrorPanel } from '../components/states/status-panels';
import { AccessTokenCreateDialog } from './access-token-create-dialog';
import { formatDay, tokenStatus, type TokenStatus } from './token-facts';
import { useAccessTokens, type AccessToken } from './use-access-tokens';

/**
 * The caller's personal access tokens: every one ever issued, and the controls to mint and revoke.
 *
 * **Revoked and expired tokens stay in the table.** The list is an audit of what has been able to
 * act as this principal, and an audit that forgets is not one - so a dead token keeps its row,
 * visibly told apart by its status tag and its muted name rather than removed. Only live rows
 * offer Revoke, because revoking a dead token does nothing the row does not already say.
 *
 * **Revoke confirms first.** It is destructive in the way that matters - any client holding the
 * token loses access on its next request, immediately, with no undo - and unlike deleting a note
 * there is nothing to restore: minting a replacement produces a different secret that every
 * client has to be given by hand.
 */

/** How "never used" is written. A blank cell reads as missing data; this is an answer. */
const NEVER = 'never';

function statusTag(status: TokenStatus): ReactNode {
  if (status.kind === 'live') {
    return <Tag tone="accent">Live</Tag>;
  }

  if (status.kind === 'revoked') {
    return <Tag tone="muted">Revoked {formatDay(status.at)}</Tag>;
  }

  return <Tag tone="muted">Expired {formatDay(status.at)}</Tag>;
}

export function AccessTokensSection(): ReactElement {
  const { status, tokens, error, reload, create, revoke } = useAccessTokens();

  const [createOpen, setCreateOpen] = useState(false);

  /** The token a revocation is being confirmed for, or null while none is. */
  const [revoking, setRevoking] = useState<AccessToken | null>(null);
  const [revokeRefusal, setRevokeRefusal] = useState<string | null>(null);
  const [revokeInFlight, setRevokeInFlight] = useState(false);

  // Taken once per render rather than once per row: sixty rows asking the clock separately could
  // disagree about which side of an expiry boundary "now" is on within one paint.
  const now = new Date();

  async function confirmRevoke(token: AccessToken): Promise<void> {
    setRevokeInFlight(true);
    setRevokeRefusal(null);
    try {
      const { refusal } = await revoke(token.id);
      if (refusal !== null) {
        // The dialog stays open over a failure: closing it would report, by implication, a
        // revocation that never happened.
        setRevokeRefusal(refusal);
        return;
      }

      setRevoking(null);
      await reload();
    } finally {
      setRevokeInFlight(false);
    }
  }

  const columns = [
    {
      key: 'name',
      header: 'Name',
      rowHeader: true,
      cell: (token: AccessToken) =>
        tokenStatus(token, now).kind === 'live' ? (
          token.name
        ) : (
          // The muted role rather than an opacity wash, so a dead row stays readable - distinct
          // is not the same as illegible, and an audit row nobody can read is not an audit.
          <Text as="span" variant="bodySmall" tone="muted">
            {token.name}
          </Text>
        ),
    },
    {
      key: 'scopes',
      header: 'Scopes',
      cell: (token: AccessToken) => (
        <span className="inline-flex flex-wrap gap-1">
          {token.scopes.map((scope) => (
            <Tag key={scope}>{scope}</Tag>
          ))}
        </span>
      ),
    },
    {
      key: 'createdAt',
      header: 'Created',
      cell: (token: AccessToken) => formatDay(token.createdAt),
    },
    {
      key: 'expiresAt',
      header: 'Expires',
      cell: (token: AccessToken) => formatDay(token.expiresAt),
    },
    {
      key: 'lastUsedAt',
      header: 'Last used',
      cell: (token: AccessToken) =>
        token.lastUsedAt === null ? (
          <Text as="span" variant="bodySmall" tone="muted">
            {NEVER}
          </Text>
        ) : (
          formatDay(token.lastUsedAt)
        ),
    },
    {
      key: 'status',
      header: 'Status',
      cell: (token: AccessToken) => statusTag(tokenStatus(token, now)),
    },
    {
      key: 'actions',
      header: 'Actions',
      cell: (token: AccessToken) =>
        tokenStatus(token, now).kind === 'live' ? (
          <Button
            variant="ghost"
            onClick={() => {
              setRevokeRefusal(null);
              setRevoking(token);
            }}
          >
            Revoke {token.name}
          </Button>
        ) : null,
    },
  ] as const;

  return (
    <section aria-labelledby="access-tokens-heading" className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Text id="access-tokens-heading" variant="h3" as="h2">
          Access tokens
        </Text>
        <Button
          onClick={() => {
            setCreateOpen(true);
          }}
        >
          Create token
        </Button>
      </div>
      <Text variant="note" tone="muted">
        Tokens let a script or machine act as you, within the scopes and lifetime you choose here.
        Every token you have issued is listed, including revoked and expired ones: this is the
        audit of what has been able to act as your account.
      </Text>

      {status === 'error' ? (
        <ErrorPanel
          title="Your tokens could not be loaded"
          detail={error ?? 'Something went wrong reading your access tokens.'}
          action={
            <Button
              variant="secondary"
              onClick={() => {
                void reload();
              }}
            >
              Try again
            </Button>
          }
        />
      ) : (
        <Table
          caption="Your personal access tokens, newest first."
          columns={columns}
          rows={tokens}
          rowKey={(token) => token.id}
          loading={status === 'loading'}
          loadingMessage="Loading your access tokens."
          emptyMessage="You have no access tokens. Create one to let a script or machine act as you."
        />
      )}

      {/* Mounted only while open, the same call `editor-page.tsx` makes for its export dialog: a
          dialog that stays mounted keeps its form in the document for queries and assistive
          technology to stumble over, and unmounting on close is also what resets the form. */}
      {createOpen ? (
        <AccessTokenCreateDialog
          open
          create={create}
          onClose={(createdToken) => {
            setCreateOpen(false);
            if (createdToken) {
              void reload();
            }
          }}
        />
      ) : null}

      {revoking === null ? null : (
        <Dialog
          open
          title={`Revoke ${revoking.name}?`}
          onClose={() => {
            if (!revokeInFlight) {
              setRevoking(null);
            }
          }}
          closeLabel="Keep the token"
          actions={
            <>
              <Button
                variant="secondary"
                disabled={revokeInFlight}
                onClick={() => {
                  setRevoking(null);
                }}
              >
                Cancel
              </Button>
              <Button
                disabled={revokeInFlight}
                onClick={() => {
                  void confirmRevoke(revoking);
                }}
              >
                {revokeInFlight ? 'Revoking the token' : 'Revoke token'}
              </Button>
            </>
          }
        >
          <div className="flex flex-col gap-2">
            <Text variant="bodySmall">
              Any client using this token loses access immediately, and there is no undo: a
              replacement means minting a new token and handing its secret to every client again.
            </Text>
            {revokeRefusal === null ? null : (
              <Text variant="note" role="alert">
                {revokeRefusal}
              </Text>
            )}
          </div>
        </Dialog>
      )}
    </section>
  );
}
