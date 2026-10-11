import { describe, expect, it } from 'vitest';

import {
  MAX_DOWNLOAD_BYTES,
  UnsupportedDownload,
  prepareDownload,
  safeFileName,
} from './downloads.js';
import { downloadHeaders } from './serve.js';

const bytes = (text: string) => new TextEncoder().encode(text);

describe('prepareDownload', () => {
  it('publishes a PDF, a text file and a CSV under fixed types and safe names', () => {
    const pdf = prepareDownload(bytes('%PDF-1.4\n'), 'application/pdf', 'Annual Report (2026).pdf');
    expect(pdf).toMatchObject({
      ext: 'pdf',
      mediaType: 'application/pdf',
      fileName: 'Annual-Report-2026.pdf',
    });
    expect(pdf.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(prepareDownload(bytes('a,b\n'), 'text/csv; charset=utf-8', 'data.csv').mediaType).toBe(
      'text/csv',
    );
    expect(prepareDownload(bytes('hi'), 'text/plain', '../../etc/passwd').fileName).toBe(
      'passwd.txt',
    );
  });

  it('refuses other types, mislabelled files, empty and oversized files', () => {
    for (const [content, type] of [
      [bytes('<html>'), 'text/html'],
      [bytes('<html>'), 'application/pdf'],
      [new Uint8Array([0xff, 0xfe, 0xfd]), 'text/plain'],
      [new Uint8Array(0), 'text/plain'],
      [new Uint8Array(MAX_DOWNLOAD_BYTES + 1), 'text/plain'],
      [bytes('x'), 'constructor'],
    ] as const) {
      expect(() => prepareDownload(content, type, 'f'), type).toThrow(UnsupportedDownload);
    }
  });

  it('never returns an empty or hidden name', () => {
    expect(safeFileName('...', 'pdf')).toBe('download.pdf');
    expect(safeFileName('Résumé.pdf', 'pdf')).toBe('Resume.pdf');
    expect(safeFileName('.env', 'txt')).toBe('env.txt');
  });
});

describe('downloadHeaders', () => {
  const sha = 'a'.repeat(64);

  it('downloads every file, a PDF also sandboxed', () => {
    expect(downloadHeaders(`/_nix/files/${sha}/CV.pdf`)).toEqual({
      'Content-Type': 'application/pdf',
      'Content-Disposition': 'attachment; filename="CV.pdf"',
      'Content-Security-Policy': "sandbox; default-src 'none'; frame-ancestors 'none'",
    });
    expect(downloadHeaders(`/_nix/files/${sha}/notes.csv`)).toMatchObject({
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': 'attachment; filename="notes.csv"',
    });
  });

  it('refuses anything that is not a published download path', () => {
    for (const path of [
      `/_nix/files/${sha}/a.html`,
      `/_nix/files/${sha}/a"b.pdf`,
      `/_nix/files/${sha}/.pdf`,
      `/_nix/files/abc/a.pdf`,
      `/files/${sha}/a.pdf`,
    ]) {
      expect(downloadHeaders(path), path).toBeNull();
    }
  });
});
