// Demo mode: feeds realistic sample events into the UI without requiring a
// C2PA-signed stream. Run in the browser console:
//   __c2paApp.demo()

function hexBytes(hex) {
  const clean = hex.replace(/[^0-9a-f]/gi, '');
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.substr(i * 2, 2), 16);
  return out;
}

export function sampleManifest(seq) {
  return {
    label: `urn:c2pa:6fa43a2c-8c34-4f2b-90d1-${String(100000000000 + seq)}`,
    instanceId: `xmp:iid:e4f1b2a0-77aa-4d21-9c55-${String(200000000000 + seq)}`,
    claimGenerator: 'qualabs-live-signer/1.2.0 c2pa-rs/0.36.1',
    signatureInfo: {
      issuer: 'C2PA Live Demo Signing CA',
      certNotBefore: '2026-01-15T00:00:00Z',
    },
    assertions: [
      {
        label: 'c2pa.live-video',
        data: {
          sequenceNumber: seq,
          streamId: 'video-avc1-1080p',
          continuityMethod: 'previousManifest',
          previousManifestId: seq > 1 ? `urn:c2pa:6fa43a2c-8c34-4f2b-90d1-${String(100000000000 + seq - 1)}` : null,
          anchorPoint: seq % 30 === 1,
        },
      },
      {
        label: 'c2pa.hash.bmff.v2',
        data: {
          alg: 'sha256',
          hash: hexBytes('9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08'),
          exclusions: [
            { xpath: '/uuid' },
            { xpath: '/ftyp' },
            { xpath: '/mfhd/sequence_number' },
          ],
        },
      },
      {
        label: 'c2pa.actions.v2',
        data: {
          actions: [
            { action: 'c2pa.created', digitalSourceType: 'http://cv.iptc.org/newscodes/digitalsourcetype/digitalCapture' },
            { action: 'c2pa.transcoded', softwareAgent: { name: 'ffmpeg', version: '7.1' } },
          ],
        },
      },
      {
        label: 'c2pa.session-keys',
        data: {
          keys: [
            {
              kid: 'a1b2c3d4e5f6',
              kty: 'EC',
              crv: 'P-256',
              minSequenceNumber: 1,
              validityPeriod: 3600,
              createdAt: '2026-07-12T09:00:00Z',
            },
          ],
        },
      },
    ],
  };
}

export function runDemo(handlers) {
  const { onInitProcessed, onSegmentValidated, onError } = handlers;
  let seq = 1;

  const record = (overrides) => ({
    mediaType: 'video',
    keyId: 'a1b2c3d4e5f6',
    hash: '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08',
    timestamp: Date.now(),
    quality: '1080p',
    ...overrides,
  });

  const validSegment = () => {
    const n = seq++;
    onSegmentValidated(record({ segmentNumber: n, status: 'valid', manifest: sampleManifest(n) }));
  };

  onInitProcessed({
    success: true,
    sessionKeysCount: 1,
    manifestId: sampleManifest(1).label,
    manifest: sampleManifest(1),
  });

  const steps = [];
  for (let i = 0; i < 6; i++) steps.push(validSegment);
  steps.push(() => {
    const n = seq++;
    onSegmentValidated(
      record({
        segmentNumber: n,
        status: 'warning',
        errorCodes: ['assertion.action.ingredientMismatch'],
        manifest: sampleManifest(n),
      })
    );
  });
  for (let i = 0; i < 3; i++) steps.push(validSegment);
  steps.push(() => {
    const n = seq++;
    onSegmentValidated(
      record({
        segmentNumber: n,
        status: 'invalid',
        errorCodes: ['livevideo.segment.invalid', 'claim.signature.mismatch'],
        manifest: sampleManifest(n),
      })
    );
  });
  steps.push(() => {
    onSegmentValidated(
      record({
        segmentNumber: seq - 1,
        status: 'replayed',
        sequenceReason: 'duplicate',
        errorCodes: ['livevideo.assertion.invalid'],
      })
    );
  });
  steps.push(() => {
    seq += 3;
    onSegmentValidated(
      record({
        segmentNumber: seq++,
        status: 'missing',
        sequenceReason: 'gap_detected',
      })
    );
  });
  for (let i = 0; i < 4; i++) steps.push(validSegment);
  steps.push(() => onError({ source: 'demo', error: new Error('Example of an internal pipeline error') }));

  let i = 0;
  const timer = setInterval(() => {
    if (i >= steps.length) {
      clearInterval(timer);
      return;
    }
    steps[i++]();
  }, 600);
  return () => clearInterval(timer);
}
