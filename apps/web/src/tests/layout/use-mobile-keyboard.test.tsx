import { act, render, screen, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { useMobileKeyboard } from '../../layout/use-mobile-keyboard';
function Harness() {
  const visible = useMobileKeyboard(true);
  return (
    <>
      <input aria-label="Writing" />
      <output aria-label="Keyboard">{String(visible)}</output>
    </>
  );
}
it('collapses chrome for an occluding keyboard, but not pinch zoom or an unfocused page', async () => {
  const viewport = Object.assign(new EventTarget(), { height: 800, scale: 1 });
  vi.stubGlobal('innerHeight', 800);
  vi.stubGlobal('visualViewport', viewport);
  render(<Harness />);
  act(() => {
    screen.getByRole('textbox', { name: 'Writing' }).focus();
    viewport.height = 480;
    viewport.dispatchEvent(new Event('resize'));
  });
  await waitFor(() => {
    expect(screen.getByLabelText('Keyboard')).toHaveTextContent('true');
  });
  act(() => {
    viewport.scale = 2;
    viewport.dispatchEvent(new Event('resize'));
  });
  await waitFor(() => {
    expect(screen.getByLabelText('Keyboard')).toHaveTextContent('false');
  });
  act(() => {
    viewport.scale = 1;
    screen.getByRole('textbox', { name: 'Writing' }).blur();
    viewport.dispatchEvent(new Event('resize'));
  });
  await waitFor(() => {
    expect(screen.getByLabelText('Keyboard')).toHaveTextContent('false');
  });
});
it('works when the visual viewport API is unavailable', async () => {
  vi.stubGlobal('visualViewport', undefined);
  render(<Harness />);
  act(() => {
    screen.getByRole('textbox', { name: 'Writing' }).focus();
  });
  await waitFor(() => {
    expect(screen.getByLabelText('Keyboard')).toHaveTextContent('false');
  });
});
