export const COMPRESSIBLE_IMAGE_MIMES = Object.freeze([
  'image/avif',
  'image/bmp',
  'image/heic',
  'image/heif',
  'image/jpeg',
  'image/jpg',
  'image/png',
  'image/webp',
]);

const COMPRESSIBLE_IMAGE_EXTENSIONS = /\.(avif|bmp|heic|heif|jpe?g|png|webp)$/i;

export function isCompressibleImage(mime, filename = '') {
  return (
    COMPRESSIBLE_IMAGE_MIMES.includes(String(mime ?? '').toLowerCase()) ||
    COMPRESSIBLE_IMAGE_EXTENSIONS.test(String(filename ?? ''))
  );
}

export function compressedImageFilename(filename) {
  const name = String(filename || 'photo').trim() || 'photo';
  const base = name.replace(/\.[^./\\]+$/, '');
  return `${base || 'photo'}.jpg`;
}

export function fitWithinBox(width, height, maxDimension) {
  const w = Math.max(1, Number(width) || 1);
  const h = Math.max(1, Number(height) || 1);
  const limit = Math.max(1, Number(maxDimension) || 1);
  const scale = Math.min(1, limit / Math.max(w, h));
  return {
    width: Math.max(1, Math.round(w * scale)),
    height: Math.max(1, Math.round(h * scale)),
  };
}
