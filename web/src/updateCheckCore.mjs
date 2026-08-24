// Pure update decision logic shared by the browser update paths.
export function assessUpdate(localSha, remote, state, now, stuckAfterMs = 60_000) {
  if (!remote || !remote.sha) return 'current';
  if (remote.sha === localSha) {
    state.remoteSha = null;
    state.firstMismatchAt = null;
    return 'current';
  }
  state.remoteSha = remote.sha;
  if (state.firstMismatchAt === null || state.firstMismatchAt === undefined) state.firstMismatchAt = now;
  if (state.controllerChanged) return 'newer-available';
  if (now - state.firstMismatchAt >= stuckAfterMs) return 'stuck';
  return 'newer-available';
}
