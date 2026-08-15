const INLINE_MEDIA = /^(?:image\/(?:avif|gif|jpeg|png|webp)|audio\/[a-z0-9.+-]+|video\/[a-z0-9.+-]+)$/;

/**
 * Same-origin inline rendering is an allowlist, never a guess from an untrusted
 * filename. Everything that could carry active content (HTML, SVG, XML, PDF,
 * scripts, and unknown formats) is reduced to an opaque download.
 */
export function mediaResponsePolicy(mime: string): { mime: string; disposition: 'inline' | 'attachment' } {
  const declared = mime.toLowerCase().split(';', 1)[0].trim();
  return INLINE_MEDIA.test(declared)
    ? { mime: declared, disposition: 'inline' }
    : { mime: 'application/octet-stream', disposition: 'attachment' };
}
