'use strict';

const DEFAULT_DEV_URL = 'http://localhost:5173';

function readArgument(args, name) {
  const prefix = `${name}=`;
  const argument = args.find((value) => value.startsWith(prefix));
  return argument ? argument.slice(prefix.length) : null;
}

function normalizeUrl(value) {
  if (!value) {
    return null;
  }

  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`Nix server URL is not valid: ${value}`);
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('Nix server URL must use http or https.');
  }

  url.hash = '';
  return url.toString().replace(/\/$/, '');
}

function isSafeExternalUrl(value) {
  try {
    const protocol = new URL(value).protocol;
    return protocol === 'http:' || protocol === 'https:' || protocol === 'mailto:';
  } catch {
    return false;
  }
}

function resolveWebUrl({ args = [], env = process.env, isPackaged = false } = {}) {
  const requested = readArgument(args, '--web-url') || env.NIX_DESKTOP_WEB_URL || null;
  if (requested) {
    return normalizeUrl(requested);
  }

  if (!isPackaged || args.includes('--dev')) {
    return DEFAULT_DEV_URL;
  }

  throw new Error(
    'Nix server URL is not configured. Set NIX_DESKTOP_WEB_URL or launch with --web-url=<url>.',
  );
}

module.exports = { DEFAULT_DEV_URL, isSafeExternalUrl, normalizeUrl, resolveWebUrl };
