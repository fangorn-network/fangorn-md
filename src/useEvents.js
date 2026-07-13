import { useEffect, useRef } from "react";

/**
 * One EventSource on /api/events for the app's lifetime. The server emits:
 *   - "local-change":  docs/ changed on disk (external editor, a pull, ...)
 *   - "remote-change": the namespace owner pushed a new on-chain commit —
 *                      the payload is the NamespaceChange from `fangorn.subscribe`
 *
 * Handlers are kept in a ref so re-renders don't reconnect the stream.
 */
export function useEvents(handlers) {
    const ref = useRef(handlers);
    ref.current = handlers;

    useEffect(() => {
        const source = new EventSource("/api/events");
        source.addEventListener("local-change", (e) =>
            ref.current.onLocalChange?.(JSON.parse(e.data)),
        );
        source.addEventListener("remote-change", (e) =>
            ref.current.onRemoteChange?.(JSON.parse(e.data)),
        );
        return () => source.close();
    }, []);
}
