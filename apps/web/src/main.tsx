import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router';

import { initializeExcalidrawAssets } from './lib/excalidraw-assets';
import { registerServiceWorker } from './pwa/register-service-worker';
import './app.css';

/**
 * Browser entry point. Boot concerns get their own modules and are composed
 * here before the router hands off to <App />.
 */

initializeExcalidrawAssets();

const rootElement = document.getElementById('root');
if (rootElement === null) {
  throw new Error('Mount point #root is missing from index.html');
}
const rootContainer: HTMLElement = rootElement;

registerServiceWorker();

async function mountApplication(): Promise<void> {
  // Excalidraw reads its global asset path while its module is evaluated. Loading the application
  // only after initializeExcalidrawAssets() keeps its fonts on this origin instead of capturing the
  // package's public-CDN fallback before the first statement in this entry point can run.
  const { App } = await import('./app');

  createRoot(rootContainer).render(
    <StrictMode>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </StrictMode>,
  );
}

void mountApplication();
