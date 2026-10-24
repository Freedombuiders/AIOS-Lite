export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** SIGTERM (or SIGKILL when force). Returns false when the process is gone or cannot be signalled. */
export function killProcess(pid: number, force = false): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, force ? 'SIGKILL' : 'SIGTERM');
    return true;
  } catch {
    return false;
  }
}
