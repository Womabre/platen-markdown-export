/**
 * Bounded concurrency helpers.
 *
 * The renderers (Mermaid, draw.io, image inlining) each fan out over every
 * match in a document. Unbounded, a 30-diagram document opens 30 Chromium
 * pages, spawns 30 draw.io Electron processes, or decodes 30 full-resolution
 * images at once — enough to thrash or OOM a laptop. These helpers cap the
 * in-flight work while keeping the callers' shape (and result ordering)
 * identical to the `Promise.all` they replace.
 */

/**
 * Returns a gate that runs at most `limit` tasks at a time.
 *
 * Queued tasks start in the order they were submitted. A rejected task
 * releases its slot like any other, so one failure never wedges the gate.
 */
export function createLimiter(limit: number): <T>(task: () => Promise<T>) => Promise<T> {
    const max     = Math.max(1, Math.floor(limit));
    const waiting: Array<() => void> = [];
    let active = 0;

    const release = (): void => {
        active--;
        waiting.shift()?.();
    };

    return <T>(task: () => Promise<T>): Promise<T> => {
        const start = async (): Promise<T> => {
            active++;
            try {
                return await task();
            } finally {
                release();
            }
        };

        if (active < max) return start();
        return new Promise<void>(resolve => waiting.push(resolve)).then(start);
    };
}

/**
 * `Promise.all(items.map(fn))` with at most `limit` calls in flight.
 *
 * Results keep the input order, and — like `Promise.all` — the first rejection
 * rejects the whole call. Callers that must not lose a partial result should
 * catch inside `fn`, as the renderers do.
 */
export function mapPool<T, R>(
    items: readonly T[],
    limit: number,
    fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
    const run = createLimiter(limit);
    return Promise.all(items.map((item, i) => run(() => fn(item, i))));
}
