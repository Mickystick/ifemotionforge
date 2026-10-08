import { subscribeToChanges } from "../lib/changes.js";
/**
 * How often to write a comment line down an idle stream, in milliseconds.
 *
 * Nothing reads it. It exists because everything between this server and the
 * browser — a Vite dev proxy, Nginx, a Cloudflare tunnel, a phone's carrier NAT
 * — will eventually close a connection that has said nothing, and the failure
 * is silent: the stream dies, and the screen goes quietly back to being stale
 * without anybody being told. Well under the usual sixty-second idle timeouts.
 */
const HEARTBEAT_MS = 25_000;
/**
 * How long a browser should wait before reconnecting, in milliseconds.
 *
 * `EventSource` reconnects on its own; this only sets the delay. Three seconds
 * is short enough that a laptop waking from sleep is live again before anybody
 * reaches for the mouse, and long enough that a server restart is not met with
 * a reconnection attempt from every open tab at once.
 */
const RETRY_MS = 3_000;
/**
 * The live stream: one long-lived response per open tab, saying when to re-read.
 *
 * Server-sent events rather than websockets, because the traffic is entirely
 * one-way. The browser already has a perfectly good way to talk to the server —
 * it is the rest of this API — and everything a websocket would add here is
 * machinery for a direction nothing sends in. SSE is also plain HTTP, so it
 * survives the session cookie, the CORS config, the dev proxy and the Nginx in
 * front of production without any of them being taught a second protocol, and
 * `EventSource` handles reconnection and backoff without a line of code.
 *
 * What travels is a nudge, never data. The event says "something changed"; the
 * browser answers by re-reading through the same endpoints it always uses, with
 * the same permission checks. That is what keeps this route from becoming a
 * second, subtly different way to read the ledger — the failure that would put
 * a figure on one screen that no endpoint would agree with.
 *
 * Two things to know before this is deployed behind anything:
 *
 *  - Whatever sits in front must not buffer. Nginx needs `proxy_buffering off`
 *    for this location — the `X-Accel-Buffering` header below asks for it, but
 *    only Nginx reads that header. A buffering proxy does not fail; it delivers
 *    the news in batches whenever its buffer happens to fill, which looks
 *    exactly like the staleness this was built to remove.
 *
 *  - One open tab holds one connection for as long as it is open. Over HTTP/1.1
 *    a browser allows six per origin, so somebody with six Lindero tabs would
 *    find the seventh unable to make any request at all. HTTP/2 — which is to
 *    say, serving the app over TLS — multiplexes them and the limit disappears.
 *    Worth knowing rather than worth working around: nobody keeps six tabs of
 *    this open, and production should be on TLS regardless.
 */
export const eventRoutes = async (app) => {
    /** Every open stream, so shutdown can end them instead of waiting on them. */
    const open = new Set();
    /*
     * End the streams before Fastify waits for them.
     *
     * `preClose` runs before `app.close()` starts waiting on open connections. A
     * hijacked stream never finishes by itself, so without this a single open
     * tab holds shutdown up until systemd's TimeoutStopSec runs out and it sends
     * SIGKILL. Browsers reconnect on their own, after `RETRY_MS`, once the new
     * process is up.
     */
    app.addHook("preClose", async () => {
        for (const stream of open) {
            stream.end();
        }
        open.clear();
    });
    app.get("/events", { onRequest: app.requireUser }, async (request, reply) => {
        const clientId = typeof request.query.clientId === "string" && request.query.clientId !== ""
            ? request.query.clientId
            : null;
        /*
         * Take the socket off Fastify.
         *
         * Every reply Fastify manages is a response that ENDS, and this one must
         * not: it is written to for as long as the tab is open. `hijack` is how
         * that is said — after it, the lifecycle hooks stay out of the way and
         * the raw stream below is ours to close.
         */
        reply.hijack();
        const stream = reply.raw;
        open.add(stream);
        // Node will otherwise apply the server's idle timeout to a connection
        // that is idle by design between heartbeats.
        request.socket.setTimeout(0);
        stream.writeHead(200, {
            "Content-Type": "text/event-stream; charset=utf-8",
            // `no-transform` as well as `no-cache`: a proxy that "helpfully"
            // compresses or buffers this stream turns a live feed into a batch that
            // arrives whenever the buffer happens to fill.
            "Cache-Control": "no-cache, no-transform",
            Connection: "keep-alive",
            // Nginx's own buffering, which the header above does not cover.
            "X-Accel-Buffering": "no",
        });
        stream.write(`retry: ${RETRY_MS}\n\n`);
        const unsubscribe = subscribeToChanges((event) => {
            // This tab's own write. It re-read the moment the response landed; a
            // second refresh now would be the same request twice.
            if (clientId !== null && event.origin === clientId) {
                return;
            }
            stream.write(`event: change\ndata: ${JSON.stringify(event)}\n\n`);
        });
        const heartbeat = setInterval(() => {
            // A comment line: the wire format ignores it, the intermediaries do not.
            stream.write(": keep-alive\n\n");
        }, HEARTBEAT_MS);
        // `unref` so a tab left open on somebody's second monitor cannot hold the
        // process up during a deploy.
        heartbeat.unref();
        const close = () => {
            clearInterval(heartbeat);
            unsubscribe();
            open.delete(stream);
        };
        // Both ends: the browser closing the tab, and the socket failing under us.
        request.raw.on("close", close);
        request.raw.on("error", close);
        stream.on("error", close);
    });
};
//# sourceMappingURL=events.js.map