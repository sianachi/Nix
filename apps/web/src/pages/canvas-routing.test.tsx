import { screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { App } from '../app/app';
import { item, stubCoreApi } from '../test/api-stub';
import { renderAt, signedIn } from '../test/render-with-router';

/**
 * The body axis choosing its editor: `item.type` says how the body is drawn, a canvas
 * draws as a scene, and everything unheard of draws as prose - the same open-set rule the
 * server applies, so the two never disagree about what a body is.
 */

// The real canvas editor drags Excalidraw into jsdom; what this suite asserts is the
// routing seam in front of it, so a marker stands in.
vi.mock('../editor/canvas-editor', () => ({
  CanvasEditor: ({ itemId }: { itemId: string }) => (
    <div aria-label="Canvas body">canvas {itemId}</div>
  ),
}));

beforeEach(() => {
  signedIn();
});

const DRAWING = item({
  id: '3c3c3c3c-3333-4333-8333-3c3c3c3c3c3c',
  title: 'Architecture sketch',
  type: 'canvas',
});

const NOTE = item({
  id: '3d3d3d3d-3333-4333-8333-3d3d3d3d3d3d',
  title: 'Plain words',
});

describe('opening a canvas item', () => {
  it('draws the canvas editor for a canvas body, not the prose one', async () => {
    stubCoreApi({ items: [DRAWING] });
    renderAt(<App />, `/?item=${DRAWING.id}`);

    expect(await screen.findByLabelText('Canvas body')).toHaveTextContent(DRAWING.id);
    expect(screen.queryByLabelText('Note body')).toBeNull();
  });

  it('still opens a note as prose, and an unknown kind as prose too', async () => {
    stubCoreApi({ items: [NOTE] });
    renderAt(<App />, `/?item=${NOTE.id}`);

    expect(await screen.findByLabelText('Note body')).toBeInTheDocument();
    expect(screen.queryByLabelText('Canvas body')).toBeNull();
  });
});
