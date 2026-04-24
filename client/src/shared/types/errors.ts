/**
 * Type guard for Node.js errors that carry a `code` property (e.g. 'ENOENT',
 * 'EACCES'). Avoids the `(error as any).code` pattern while keeping the narrow
 * runtime check that actually matters.
 */
export function isNodeErrno(error: unknown): error is NodeJS.ErrnoException {
  return (
    error instanceof Error &&
    'code' in error &&
    typeof (error as { code?: unknown }).code === 'string'
  );
}
