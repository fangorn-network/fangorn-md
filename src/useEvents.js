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
    // getToken too: Privy memoises it on internal state, so it changes identity
    // at least once after login. Keying the effect on it would tear down and
    // rebuild the stream — and every rebuild costs the server a recursive fs
    // watcher plus one chain subscription per tracked namespace.
    const tokenRef = useRef(getToken);
    tokenRef.current = getToken;

    useEffect(() => {
        if (!address) return;
        let source;
        let closed = false;
        (async () => {
            const token = await tokenRef.current?.();
            if (closed || !token) return;
            const q = new URLSearchParams({ token, address });
            source = new EventSource(`/api/events?${q}`);
            source.addEventListener("local-change", (e) => ref.current.onLocalChange?.(JSON.parse(e.data)));
            source.addEventListener("remote-change", (e) => ref.current.onRemoteChange?.(JSON.parse(e.data)));
        })();
        return () => { closed = true; source?.close(); };
    }, [address]);
}
