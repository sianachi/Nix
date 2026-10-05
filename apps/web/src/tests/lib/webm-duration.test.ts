import { describe, expect, it } from 'vitest';

import { withWebmDuration } from '../../lib/webm-duration';

function text(value: string): number[] {
  return Array.from(new TextEncoder().encode(value));
}

function element(id: readonly number[], payload: readonly number[]): number[] {
  return [...id, 0x80 | payload.length, ...payload];
}

const HEADER = element([0x1a, 0x45, 0xdf, 0xa3], [0x42, 0x82, 0x84, ...text('webm')]);
const TIMECODE_SCALE = [0x2a, 0xd7, 0xb1, 0x83, 0x0f, 0x42, 0x40];
const TRACKS = element([0x16, 0x54, 0xae, 0x6b], [0x86, ...text('A_OPUS')]);
const STREAMED_SEGMENT = [0x18, 0x53, 0x80, 0x67, 0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff];
const INFO_ID = [0x15, 0x49, 0xa9, 0x66];

function recording(info: readonly number[], segment = STREAMED_SEGMENT): Uint8Array {
  return Uint8Array.from([...HEADER, ...segment, ...element(INFO_ID, info), ...TRACKS]);
}

function durationIn(bytes: Uint8Array): number {
  const at = bytes.findIndex(
    (byte, index) => byte === 0x44 && bytes[index + 1] === 0x89 && bytes[index + 2] === 0x88,
  );
  if (at < 0) throw new Error('No Duration element was written');
  return new DataView(bytes.buffer).getFloat64(at + 3);
}

describe('writing a length into a streamed WebM recording', () => {
  it('adds the Duration a recorder leaves out and grows Info to hold it', () => {
    const head = recording(TIMECODE_SCALE);

    const patched = withWebmDuration(head, 90_000);

    expect(patched).not.toBeNull();
    if (patched === null) return;
    expect(patched.length).toBe(head.length + 11);
    expect(durationIn(patched)).toBe(90_000);
    const infoSizeAt = HEADER.length + STREAMED_SEGMENT.length + INFO_ID.length;
    expect(patched[infoSizeAt]).toBe(0x80 | (TIMECODE_SCALE.length + 11));
    // Everything after Info is carried over untouched.
    expect([...patched.slice(-TRACKS.length)]).toEqual(TRACKS);
  });

  it('counts in the file’s own ticks when they are not milliseconds', () => {
    const halfMillisecondTicks = [0x2a, 0xd7, 0xb1, 0x83, 0x07, 0xa1, 0x20];

    const patched = withWebmDuration(recording(halfMillisecondTicks), 1_000);

    expect(patched === null ? null : durationIn(patched)).toBe(2_000);
  });

  it('overwrites a Duration that is already there without moving anything', () => {
    const stale = [0x44, 0x89, 0x88, 0, 0, 0, 0, 0, 0, 0, 0];
    const head = recording([...TIMECODE_SCALE, ...stale]);

    const patched = withWebmDuration(head, 4_500);

    expect(patched?.length).toBe(head.length);
    expect(patched === null ? null : durationIn(patched)).toBe(4_500);
  });

  it('leaves alone anything it could damage', () => {
    const sizedSegment = [0x18, 0x53, 0x80, 0x67, 0x80 | 30];

    expect(withWebmDuration(Uint8Array.from(text('OggS not webm at all')), 1_000)).toBeNull();
    expect(withWebmDuration(recording(TIMECODE_SCALE, sizedSegment), 1_000)).toBeNull();
    expect(withWebmDuration(recording(TIMECODE_SCALE).slice(0, 26), 1_000)).toBeNull();
    expect(withWebmDuration(recording(TIMECODE_SCALE), 0)).toBeNull();
  });
});
