/** Safe runtime mount point for a reverse proxy which strips the service prefix. */
export function normalizeBasePath(value = '/'): string {
  if (!/^\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]*$/.test(value)) throw new Error('Base path must contain plain URL path segments');
  return value === '/' ? '/' : value.replace(/\/$/, '') + '/';
}
export function prefixDocument(html: string, basePath: string): string {
  const base = normalizeBasePath(basePath);
  return html.replace('<head>', `<head><meta name="ours-base-path" content="${base}">`)
    .replace(/((?:src|href)=")\.?\/(?!\/)([^"\s]+)(")/g, `$1${base}$2$3`);
}
