import assert from 'node:assert/strict';
import { mediaResponsePolicy } from '../src/media-response.ts';

for (const mime of [
  'text/html', 'application/xhtml+xml', 'image/svg+xml', 'application/xml', 'text/xml',
  'application/pdf', 'application/javascript', 'text/plain', 'application/x-unknown',
]) {
  assert.deepEqual(mediaResponsePolicy(mime), { mime: 'application/octet-stream', disposition: 'attachment' },
    `${mime} cannot become active same-origin content`);
}

assert.deepEqual(mediaResponsePolicy('image/png; untrusted=parameter'), { mime: 'image/png', disposition: 'inline' });
assert.deepEqual(mediaResponsePolicy('audio/ogg;codecs=opus'), { mime: 'audio/ogg', disposition: 'inline' });
assert.deepEqual(mediaResponsePolicy('video/webm'), { mime: 'video/webm', disposition: 'inline' });

console.log('media-response OK — active/unknown allowlist denial and safe raster/audio/video inline policy');
