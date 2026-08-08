import { render, screen, waitFor } from '@testing-library/react';
import { type ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AuthProvider } from '../../auth/auth-provider';
import {
  ReferenceResolutionProvider,
  useReference,
} from '../../editor/reference-resolution';

/**
 * What a reference resolves to, and - the part that matters - what it refuses to resolve to.
 *
 * A reference node stores the target's title as it was when the link was made, so the document can
 * draw something before the server answers. That cache is a title, and a reader who cannot open
 * the target has no entitlement to it. These tests are about the states that decide whether it is
 * shown, so they are written from the refused side first.
 */

const READABLE = '11111111-1111-4111-8111-111111111111';
const REFUSED = '22222222-2222-4222-8222-222222222222';

/** Reports one reference's state as text, so a test can read it the way a component would. */
function Probe({ targetId }: { readonly targetId: string }): ReactNode {
  const state = useReference(targetId);

  return (
    <span data-testid={targetId}>
      {state.status === 'resolved' ? `resolved:${state.title ?? ''}` : state.status}
    </span>
  );
}

/**
 * The provider under test, with the auth context it reads a bearer token from.
 *
 * The real `AuthProvider` rather than a stand-in: it is what supplies `getAccessToken`, and with
 * no identity provider configured it answers null - which is exactly the shape the request builder
 * has to handle and the one a fake would have hidden.
 */
function renderProbes(children: ReactNode): void {
  render(
    <AuthProvider>
      <ReferenceResolutionProvider>{children}</ReferenceResolutionProvider>
    </AuthProvider>,
  );
}

/**
 * A reference lookup answering exactly as Core does.
 *
 * Returns the recorded request urls, so the batching can be asserted rather than assumed.
 */
function stubReferences(
  answer: (ids: readonly string[]) => unknown,
  status = 200,
): { readonly calls: string[] } {
  const calls: string[] = [];

  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      calls.push(url);

      const ids = (/ids=([^&]*)/.exec(url)?.[1] ?? '')
        .split(',')
        .filter((id) => id.length > 0)
        .map((id) => decodeURIComponent(id));

      return Promise.resolve(
        new Response(JSON.stringify(answer(ids)), {
          status,
          headers: { 'content-type': 'application/json' },
        }),
      );
    }),
  );

  return { calls };
}

/** Core's answer shape: every requested identifier comes back, only some of them with an item. */
function coreAnswer(ids: readonly string[]): unknown {
  return {
    references: ids.map((id) =>
      id === READABLE
        ? {
            id,
            readable: true,
            item: {
              id,
              workspaceId: '00000000-0000-4000-8000-000000000001',
              type: 'note',
              title: 'Quarterly ledger',
            },
          }
        : { id, readable: false, item: null },
    ),
  };
}

describe('resolving what a document points at', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('reports a readable target with the title it has now', async () => {
    stubReferences(coreAnswer);
    renderProbes(<Probe targetId={READABLE} />);

    await waitFor(() => {
      expect(screen.getByTestId(READABLE)).toHaveTextContent('resolved:Quarterly ledger');
    });
  });

  it('reports a target the reader may not see as refused, and carries no title at all', async () => {
    // The one that matters. `refused` is what tells the node view to draw a stub instead of the
    // label stored in the document, which is a copy of a title this reader is not entitled to.
    stubReferences(coreAnswer);
    renderProbes(<Probe targetId={REFUSED} />);

    await waitFor(() => {
      expect(screen.getByTestId(REFUSED)).toHaveTextContent('refused');
    });
  });

  it('reports a failed lookup as unavailable rather than as refused', async () => {
    // A network failure is a fact about the network. Drawing it as a refusal would tell a reader
    // something about their own permissions that nobody established - and would replace a title
    // they are perfectly entitled to with a stub.
    stubReferences(() => ({ detail: 'nope' }), 500);
    renderProbes(<Probe targetId={READABLE} />);

    await waitFor(() => {
      expect(screen.getByTestId(READABLE)).toHaveTextContent('unavailable');
    });
  });

  it('shows the loading state until an answer arrives', () => {
    stubReferences(coreAnswer);
    renderProbes(<Probe targetId={READABLE} />);

    // Before the request settles. The stored label is what a node view draws in this state, which
    // is the one thing the label is for.
    expect(screen.getByTestId(READABLE)).toHaveTextContent('loading');
  });

  it('asks about every reference on screen in one request', async () => {
    // A note is a page of links, not one. Forty references asking separately would open forty
    // connections and queue most of them behind each other.
    const { calls } = stubReferences(coreAnswer);

    renderProbes(
      <>
        <Probe targetId={READABLE} />
        <Probe targetId={REFUSED} />
      </>,
    );

    await waitFor(() => {
      expect(screen.getByTestId(READABLE)).toHaveTextContent('resolved:Quarterly ledger');
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain(READABLE);
    expect(calls[0]).toContain(REFUSED);
  });

  it('asks once for a target mentioned twice', async () => {
    const { calls } = stubReferences(coreAnswer);

    renderProbes(
      <>
        <Probe targetId={READABLE} />
        <Probe targetId={READABLE} />
      </>,
    );

    await waitFor(() => {
      expect(screen.getAllByTestId(READABLE)[0]).toHaveTextContent('resolved:Quarterly ledger');
    });

    expect(calls).toHaveLength(1);
  });

  it('leaves a reference unresolved outside a provider rather than failing the document', async () => {
    // An editor mounted in a test or a story has no resolver. A document that refused to render
    // because its links could not be checked is a worse failure than links showing their labels.
    render(
      <AuthProvider>
        <Probe targetId={READABLE} />
      </AuthProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId(READABLE)).toHaveTextContent('loading');
    });
  });
});
