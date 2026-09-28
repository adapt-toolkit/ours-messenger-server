/** The server supplies this mount point; browser routes may be nested below it. */
export function appBasePath(): string {
  return typeof document === 'undefined' ? '/' : document.querySelector<HTMLMetaElement>('meta[name="ours-base-path"]')?.content ?? '/';
}
export function appPath(path: string): string {
  return appBasePath() + path.replace(/^\//, '');
}
export function localPath(path: string): string {
  const base = appBasePath();
  return path.startsWith(base) ? '/' + path.slice(base.length) : path;
}
