import { describe, expect, it } from 'vitest';
import {
  EMPTY_MARKDOWN_IMPORT_SCAN,
  isLocalImageTarget,
  isPersistableImageTarget,
} from './scan.js';

describe('the Markdown import scan contract', () => {
  it('keeps one fixed zero value for bodies that were not parsed', () => {
    expect(EMPTY_MARKDOWN_IMPORT_SCAN).toEqual({
      unresolvedWikiLinks: 0,
      unresolvedObsidianEmbeds: 0,
      unresolvedLocalImages: 0,
      unsupportedImageAddresses: 0,
      inlineImagesFlattened: 0,
    });
    expect(Object.isFrozen(EMPTY_MARKDOWN_IMPORT_SCAN)).toBe(true);
  });

  it('classifies filesystem image targets without calling addresses local', () => {
    for (const target of [
      './img.png',
      '../img.png',
      '/media/img.png',
      'folder/img.png',
      'C:\\Pictures\\img.png',
      'C:%5CPictures%5Cimg.png',
      '\\\\server\\share\\img.png',
      'file:///tmp/img.png',
    ]) {
      expect(isLocalImageTarget(target), target).toBe(true);
    }
  });

  it('leaves network, embedded-data, and Nix addresses out of the local category', () => {
    for (const target of [
      'https://example.test/img.png',
      'http://example.test/img.png',
      '//example.test/img.png',
      'data:image/png;base64,xyz',
      'nix://item/abc',
      'blob:https://example.test/id',
    ]) {
      expect(isLocalImageTarget(target), target).toBe(false);
    }
  });

  it('persists complete web and safe data images, but not ambiguous browser addresses', () => {
    for (const target of [
      'https://example.test/img.png',
      'http://example.test/img.png',
      'data:image/png;base64,eA==',
    ]) {
      expect(isPersistableImageTarget(target), target).toBe(true);
    }
    for (const target of [
      '',
      './img.png',
      '//example.test/img.png',
      'blob:https://example.test/id',
      'nix://item/abc',
    ]) {
      expect(isPersistableImageTarget(target), target).toBe(false);
    }
  });
});
