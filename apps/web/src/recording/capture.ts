/**
 * Everything the recorder asks of the browser's capture APIs, in one place.
 *
 * Two inputs at most: the microphone, and the audio of a tab or screen the person chooses to
 * share. When both are present they are kept apart - microphone on the left channel, shared audio
 * on the right - so a later transcript can tell the person from everybody else without guessing.
 * A microphone alone is recorded as it comes.
 */

export type RecordingSources = 'microphone' | 'microphone-and-shared';

export type CaptureFailure =
  | 'unsupported'
  | 'microphone-denied'
  | 'microphone-missing'
  | 'share-cancelled'
  | 'share-silent'
  | 'failed';

export class CaptureError extends Error {
  readonly reason: CaptureFailure;

  constructor(reason: CaptureFailure) {
    super(reason);
    this.name = 'CaptureError';
    this.reason = reason;
  }
}

export interface RecordingFormat {
  /** What the recorder is asked for, codec included. */
  readonly mimeType: string;
  /** The bare type Core accepts on an upload; it refuses parameters. */
  readonly mediaType: string;
  /** `.weba`, not `.webm`: the viewer reads the latter as video when the type is not to hand. */
  readonly extension: string;
}

const FORMATS: readonly RecordingFormat[] = [
  { mimeType: 'audio/webm;codecs=opus', mediaType: 'audio/webm', extension: 'weba' },
  { mimeType: 'audio/mp4', mediaType: 'audio/mp4', extension: 'm4a' },
  { mimeType: 'audio/ogg;codecs=opus', mediaType: 'audio/ogg', extension: 'ogg' },
];

/** Absent outside a secure context, whatever the type says. */
function mediaDevices(): Partial<MediaDevices> {
  if (typeof navigator === 'undefined') return {};
  return (navigator as { readonly mediaDevices?: MediaDevices }).mediaDevices ?? {};
}

/** The format this browser can record, or null when it cannot record at all. */
export function recordingFormat(): RecordingFormat | null {
  if (typeof MediaRecorder === 'undefined') return null;
  if (typeof mediaDevices().getUserMedia !== 'function') return null;
  return FORMATS.find((format) => MediaRecorder.isTypeSupported(format.mimeType)) ?? null;
}

/** The format a spooled recording was made in, from the type string kept beside it. */
export function formatForMimeType(mimeType: string): RecordingFormat | null {
  return FORMATS.find((format) => format.mimeType === mimeType) ?? null;
}

/** Whether this browser can be asked for a tab's or screen's audio at all. */
export function canShareAudio(): boolean {
  return (
    typeof mediaDevices().getDisplayMedia === 'function' && typeof AudioContext !== 'undefined'
  );
}

export interface Microphone {
  readonly deviceId: string;
  readonly label: string;
}

/** The microphones the browser will name. Labels are empty until permission has been given once. */
export async function listMicrophones(): Promise<Microphone[]> {
  if (typeof mediaDevices().enumerateDevices !== 'function') return [];
  const devices = await navigator.mediaDevices.enumerateDevices();
  return devices
    .filter((device) => device.kind === 'audioinput' && device.deviceId !== '')
    .map((device, index) => ({
      deviceId: device.deviceId,
      label: device.label === '' ? `Microphone ${String(index + 1)}` : device.label,
    }));
}

export interface Capture {
  /** The one stream to record. */
  readonly stream: MediaStream;
  readonly sources: RecordingSources;
  /** Told when the person stops sharing mid-recording; the microphone carries on alone. */
  onSharedEnded(listener: () => void): void;
  close(): void;
}

function stopTracks(stream: MediaStream | null): void {
  for (const track of stream?.getTracks() ?? []) track.stop();
}

function errorName(error: unknown): string {
  return error instanceof DOMException || error instanceof Error ? error.name : '';
}

async function openShared(): Promise<MediaStream> {
  let shared: MediaStream;
  try {
    // Video is asked for because browsers refuse an audio-only share; its track is never recorded.
    shared = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
  } catch (error) {
    throw new CaptureError(errorName(error) === 'NotAllowedError' ? 'share-cancelled' : 'failed');
  }
  if (shared.getAudioTracks().length === 0) {
    stopTracks(shared);
    throw new CaptureError('share-silent');
  }
  return shared;
}

async function openMicrophone(deviceId: string | null): Promise<MediaStream> {
  const audio: MediaTrackConstraints = { echoCancellation: true, noiseSuppression: true };
  try {
    return await navigator.mediaDevices.getUserMedia({
      audio: deviceId === null ? audio : { ...audio, deviceId: { exact: deviceId } },
    });
  } catch (error) {
    const name = errorName(error);
    // A remembered microphone that has since been unplugged is not a reason to refuse: fall back
    // to whichever one the browser picks.
    if (deviceId !== null && (name === 'OverconstrainedError' || name === 'NotFoundError')) {
      return openMicrophone(null);
    }
    if (name === 'NotAllowedError' || name === 'SecurityError') {
      throw new CaptureError('microphone-denied');
    }
    if (name === 'NotFoundError' || name === 'OverconstrainedError') {
      throw new CaptureError('microphone-missing');
    }
    throw new CaptureError('failed');
  }
}

export async function openCapture(options: {
  readonly deviceId: string | null;
  readonly shareAudio: boolean;
}): Promise<Capture> {
  if (recordingFormat() === null) throw new CaptureError('unsupported');

  // The share picker goes first: it needs the click that started all this, and a microphone
  // permission prompt answered slowly would use that up.
  const shared = options.shareAudio && canShareAudio() ? await openShared() : null;
  let microphone: MediaStream;
  try {
    microphone = await openMicrophone(options.deviceId);
  } catch (error) {
    stopTracks(shared);
    throw error;
  }

  if (shared === null) {
    return {
      stream: microphone,
      sources: 'microphone',
      onSharedEnded: () => undefined,
      close: () => {
        stopTracks(microphone);
      },
    };
  }

  let context: AudioContext;
  let destination: MediaStreamAudioDestinationNode;
  let sharedSource: MediaStreamAudioSourceNode;
  try {
    context = new AudioContext();
  } catch {
    stopTracks(shared);
    stopTracks(microphone);
    throw new CaptureError('failed');
  }
  try {
    const merger = context.createChannelMerger(2);
    destination = context.createMediaStreamDestination();
    sharedSource = context.createMediaStreamSource(shared);
    context.createMediaStreamSource(microphone).connect(merger, 0, 0);
    sharedSource.connect(merger, 0, 1);
    merger.connect(destination);
    await context.resume();
  } catch {
    stopTracks(shared);
    stopTracks(microphone);
    void context.close().catch(() => undefined);
    throw new CaptureError('failed');
  }

  const listeners = new Set<() => void>();
  for (const track of shared.getAudioTracks()) {
    track.addEventListener('ended', () => {
      sharedSource.disconnect();
      stopTracks(shared);
      for (const listener of listeners) listener();
    });
  }

  return {
    stream: destination.stream,
    sources: 'microphone-and-shared',
    onSharedEnded: (listener) => {
      listeners.add(listener);
    },
    close: () => {
      listeners.clear();
      stopTracks(shared);
      stopTracks(microphone);
      void context.close().catch(() => undefined);
    },
  };
}
