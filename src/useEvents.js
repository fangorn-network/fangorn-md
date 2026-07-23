import { useEffect, useRef } from "react";

/**
 * One EventSource on /api/events for the app's lifetime. The server emits:
 *   - "local-change":  the user's working tree changed on disk
 *   - "remote-change": a tracked namespace owner pushed a new on-chain commit
 *
 * EventSource can't set headers, so auth rides as query params (?token=&address=).
 * Handlers are kept in a ref so re-renders don't reconnect the stream.
 */
export function useEvents(handlers, { getToken, address }) {
    const ref = useRef(handlers);
    ref.current = handlers;

    useEffect(() => {
        if (!getToken || !address) return;
        let source;
        let closed = false;
        (async () => {
            const token = await getToken();
            if (closed) return;
            const q = new URLSearchParams({ token, address });
            source = new EventSource(`/api/events?${q}`);
            source.addEventListener("local-change", (e) => ref.current.onLocalChange?.(JSON.parse(e.data)));
            source.addEventListener("remote-change", (e) => ref.current.onRemoteChange?.(JSON.parse(e.data)));
        })();
        return () => { closed = true; source?.close(); };
    }, [getToken, address]);
}
