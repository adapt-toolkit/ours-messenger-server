import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:http';
import { build } from 'esbuild';
import { chromium } from '@playwright/test';

const temp = mkdtempSync(join(tmpdir(), 'ours-image-compression-'));
const bundle = join(temp, 'compression.mjs');
await build({ entryPoints: [resolve(new URL('../web/src/ui/imageCompression.ts', import.meta.url).pathname)], bundle: true, format: 'esm', outfile: bundle });
const server = createServer((request, response) => {
  if (request.url === '/compression.mjs') {
    response.writeHead(200, { 'content-type': 'text/javascript' }).end(readFileSync(bundle));
  } else {
    response.writeHead(200, { 'content-type': 'text/html' }).end('<!doctype html><script type="module">import {compressImageForSend} from "/compression.mjs"; globalThis.compressImageForSend=compressImageForSend;</script>');
  }
});
await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage();
  await page.goto(origin);
  await page.waitForFunction(() => typeof globalThis.compressImageForSend === 'function');
  const pixels = await page.evaluate(async () => {
    const source = document.createElement('canvas');
    source.width = 640; source.height = 320;
    const sourceContext = source.getContext('2d');
    sourceContext.clearRect(0, 0, 640, 320);
    sourceContext.fillStyle = 'rgb(230, 20, 20)';
    sourceContext.fillRect(320, 0, 320, 320);
    const png = await new Promise((resolve) => source.toBlob(resolve, 'image/png'));
    const result = await globalThis.compressImageForSend(new File([png], 'alpha.png', { type: 'image/png' }), 1024 * 1024);
    const bitmap = await createImageBitmap(new Blob([result.bytes], { type: result.mime }));
    const output = document.createElement('canvas');
    output.width = bitmap.width; output.height = bitmap.height;
    const outputContext = output.getContext('2d');
    outputContext.drawImage(bitmap, 0, 0);
    return [
      ...outputContext.getImageData(160, 160, 1, 1).data,
      ...outputContext.getImageData(480, 160, 1, 1).data,
    ];
  });
  const matte = pixels.slice(0, 3);
  const opaque = pixels.slice(4, 7);
  assert.ok(matte.every((channel) => channel >= 235), `transparent input composites onto a white JPEG matte (${matte})`);
  assert.ok(opaque[0] >= 180 && opaque[0] > opaque[1] * 3 && opaque[0] > opaque[2] * 3,
    `opaque red remains opaque and chromatically correct (${opaque})`);
} finally {
  await browser.close();
  if (server.listening) await new Promise((resolveClose) => server.close(resolveClose));
  rmSync(temp, { recursive: true, force: true });
}
console.log('browser-image-compression OK — transparent pixels receive the exact white output matte; opaque pixels remain correct');
