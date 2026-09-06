import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { describe, expect, it } from 'vitest';
import { PetMessageText } from '../../pets/pet-message-text';
const workspace = '11111111-1111-4111-8111-111111111111';
describe('pet result links', () => {
  it('makes same-workspace citations navigable', () => {
    const path = `/w/${workspace}?item=22222222-2222-4222-8222-222222222222`;
    render(
      <MemoryRouter>
        <PetMessageText workspaceId={workspace} text={`Created [Release plan](${path}).`} />
      </MemoryRouter>,
    );
    expect(screen.getByRole('link', { name: 'Release plan' })).toHaveAttribute('href', path);
  });
  it('keeps arbitrary URLs and HTML inert', () => {
    render(
      <MemoryRouter>
        <PetMessageText
          workspaceId={workspace}
          text={'[Run](javascript:alert(1)) <img src=x onerror=alert(1)>'}
        />
      </MemoryRouter>,
    );
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
  });
  it('makes a bare Nix result path clickable too', () => {
    const path = `/w/${workspace}?item=22222222-2222-4222-8222-222222222222`;
    render(
      <MemoryRouter>
        <PetMessageText workspaceId={workspace} text={`Link: ${path}`} />
      </MemoryRouter>,
    );
    expect(screen.getByRole('link', { name: 'Open note' })).toHaveAttribute('href', path);
  });
});
