import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router';

import { App } from './app/app';
import './app.css';

/**
 * Browser entry point. It does exactly three things: import the one
 * stylesheet, mount the router, and hand off to <App />. Anything else that
 * needs to happen at boot (config parsing, telemetry, auth) gets its own
 * module and is composed here, never inlined.
 */

const container = document.getElementById('root');
if (container === null) {
  throw new Error('Mount point #root is missing from index.html');
}

createRoot(container).render(
  <StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </StrictMode>,
);
