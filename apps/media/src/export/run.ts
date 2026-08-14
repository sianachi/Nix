import { BundleRefusal } from '../collab/bundles.ts';

/**
 * The produced bytes, bounded.
 *
 * **Two ceilings, checked between chunks rather than after.** A converter that runs away produces
 * bytes until the heap gives out, and a timeout that is only checked at the end is not a timeout.
 * Both are enforced where the bytes pass through, which is the one place that sees every one of them.
 *
 * **A refusal here can arrive after the first byte is sent, and then it truncates.** Once a response
 * has begun there is no status code left to change, so the honest outcome is a file that does not
 * open rather than one that opens and is quietly incomplete - the same argument the archive writer
 * makes about refusing to close a zip around a missing payload.
 */
export async function* boundedBytes(
  bytes: AsyncGenerator<Uint8Array>,
  limits: { readonly maxBytes: number; readonly signal: AbortSignal },
): AsyncGenerator<Uint8Array> {
  let written = 0;

  for await (const chunk of bytes) {
    if (limits.signal.aborted) {
      throw new BundleRefusal(
        504,
        'export_timed_out',
        'This export took longer than the service allows.',
      );
    }

    written += chunk.byteLength;

    if (written > limits.maxBytes) {
      throw new BundleRefusal(
        413,
        'export_too_large',
        'This export is larger than the service will produce. Export a smaller part of the tree.',
      );
    }

    yield chunk;
  }
}
