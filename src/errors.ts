/**
 * Error subclass that carries a specific process exit code.
 * Thrown by validate() and exportPdf() so the top-level catch handler can
 * exit with a meaningful code rather than the generic exit 1.
 *
 * Exit code conventions (documented in `--help`):
 *   3  Input file or required asset not found
 *   4  WeasyPrint not found or failed
 *   5  Network / fetch error
 */
export class ExitError extends Error {
    constructor(message: string, public readonly exitCode: number) {
        super(message);
        this.name = 'ExitError';
    }
}
