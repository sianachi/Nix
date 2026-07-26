import type { ReactElement } from 'react';
import { useLocation, useNavigate } from 'react-router';

import { Button } from '../components/button';
import { EmptyPanel } from '../components/states/status-panels';

/**
 * The catch-all route. It reuses the shared empty panel rather than inventing
 * a bespoke 404 layout, and it names the path that did not match, because
 * "not found" without saying what was not found is not an answer.
 */
export function NotFoundPage(): ReactElement {
  const location = useLocation();
  const navigate = useNavigate();

  return (
    <EmptyPanel
      title="No such page"
      detail={`Nothing is routed at ${location.pathname}. The link may be out of date, or the workspace may have moved.`}
      action={
        <Button
          variant="secondary"
          onClick={() => {
            void navigate('/');
          }}
        >
          Back to start
        </Button>
      }
    />
  );
}
