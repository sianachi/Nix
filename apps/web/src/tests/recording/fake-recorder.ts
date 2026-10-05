/**
 * A stand-in for `MediaRecorder`. jsdom has none, and a real one would need a live microphone;
 * this one records what the store asked of it and lets a test hand over slices and endings the
 * way a browser would.
 */
export class FakeMediaRecorder extends EventTarget {
  static instances: FakeMediaRecorder[] = [];
  static isTypeSupported = (): boolean => true;

  state: 'inactive' | 'recording' | 'paused' = 'inactive';
  readonly options: MediaRecorderOptions | undefined;

  constructor(_stream: MediaStream, options?: MediaRecorderOptions) {
    super();
    this.options = options;
    FakeMediaRecorder.instances.push(this);
  }

  start(): void {
    this.state = 'recording';
  }

  pause(): void {
    this.state = 'paused';
  }

  resume(): void {
    this.state = 'recording';
  }

  stop(): void {
    this.state = 'inactive';
    this.dispatchEvent(new Event('stop'));
  }

  /** The browser hands over a slice. */
  emit(data: Blob): void {
    this.dispatchEvent(Object.assign(new Event('dataavailable'), { data }));
  }
}

export function lastRecorder(): FakeMediaRecorder {
  const recorder = FakeMediaRecorder.instances.at(-1);
  if (recorder === undefined) throw new Error('No recorder was created');
  return recorder;
}

/** Just enough of the Web Locks API for one tab to see what another holds. */
export function fakeLocks(): { readonly locks: LockManager; readonly held: Set<string> } {
  const held = new Set<string>();
  const locks = {
    request: async (
      name: string,
      optionsOrCallback: { ifAvailable?: boolean } | ((lock: object | null) => unknown),
      maybeCallback?: (lock: object | null) => unknown,
    ) => {
      const callback = typeof optionsOrCallback === 'function' ? optionsOrCallback : maybeCallback;
      const ifAvailable = typeof optionsOrCallback === 'object' && optionsOrCallback.ifAvailable;
      if (callback === undefined) return undefined;
      if (held.has(name)) return ifAvailable ? callback(null) : undefined;
      held.add(name);
      try {
        return await callback({ name });
      } finally {
        held.delete(name);
      }
    },
    query: () => Promise.resolve({ held: [...held].map((name) => ({ name })), pending: [] }),
  };
  return { locks: locks as unknown as LockManager, held };
}
