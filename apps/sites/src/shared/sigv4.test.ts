import { describe, expect, it } from 'vitest';

import { signRequest } from './sigv4.ts';

// The worked examples in "Signature Calculations for the Authorization Header" of the S3 API
// reference, which use these documentation-only credentials.
const credentials = {
  region: 'us-east-1',
  accessKey: 'AKIAIOSFODNN7EXAMPLE',
  secretKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
  now: new Date('2013-05-24T00:00:00Z'),
};

function signature(headers: Record<string, string>): string {
  return /Signature=([0-9a-f]{64})$/.exec(headers.authorization ?? '')?.[1] ?? '';
}

describe('signRequest', () => {
  it('signs a GET Object with a Range header (AWS example)', () => {
    const headers = signRequest({
      ...credentials,
      method: 'GET',
      url: new URL('https://examplebucket.s3.amazonaws.com/test.txt'),
      headers: { Range: 'bytes=0-9' },
    });
    expect(signature(headers)).toBe(
      'f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41',
    );
    expect(headers.authorization).toContain(
      'SignedHeaders=host;range;x-amz-content-sha256;x-amz-date',
    );
    expect(headers.host).toBeUndefined();
  });

  it('signs a subresource query (AWS GET Bucket Lifecycle example)', () => {
    const headers = signRequest({
      ...credentials,
      method: 'GET',
      url: new URL('https://examplebucket.s3.amazonaws.com/?lifecycle'),
    });
    expect(signature(headers)).toBe(
      'fea454ca298b7da1c68078a5d1bdbfbbe0d65c699e0f91ac7a200a0136783543',
    );
  });

  it('sorts and encodes query parameters (AWS GET Bucket List Objects example)', () => {
    const headers = signRequest({
      ...credentials,
      method: 'GET',
      url: new URL('https://examplebucket.s3.amazonaws.com/?max-keys=2&prefix=J'),
    });
    expect(signature(headers)).toBe(
      '34b48302e7b5fa45bde8084f4b7868a86f0a534bc59db6670ed5711ef69dc6f7',
    );
  });
});
