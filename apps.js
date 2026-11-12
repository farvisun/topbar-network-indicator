// Parse `ss -H -O -t -i -n -p -e`: one socket per line, no DNS lookups.
export function parseAppSockets(text, {includeLoopback = false} = {}) {
    const sockets = new Map();
    for (const line of text.split('\n')) {
        const owner = line.match(/\("([^"\n]+)",pid=(\d+),fd=\d+\)/);
        const cookie = line.match(/\bsk:([\da-f]+)/i)?.[1];
        if (!owner || !cookie)
            continue;
        const fields = line.trim().split(/\s+/);
        if (fields[0] !== 'ESTAB')
            continue;
        const peer = fields[4] ?? '';
        if (!includeLoopback && /^(127\.|\[?::1\]?:|\[?::ffff:127\.)/.test(peer))
            continue;
        const rx = Number(line.match(/\bbytes_received:(\d+)/)?.[1] ?? 0);
        const tx = Number(line.match(/\bbytes_acked:(\d+)/)?.[1] ?? 0);
        sockets.set(cookie, {name: owner[1].replace(/[\x00-\x1f\x7f]/g, ''),
            pid: Number(owner[2]), local: fields[3], peer, rx, tx});
    }
    return sockets;
}

export class AppTraffic {
    constructor() {
        this.reset();
    }

    reset() {
        this.previous = null;
        this.apps = new Map();
        this.lastTime = 0;
    }

    sample(sockets, now) {
        const elapsed = now - this.lastTime;
        const validRate = this.previous !== null && elapsed > 0 && elapsed < 10;
        for (const app of this.apps.values()) {
            app.rxRate = 0;
            app.txRate = 0;
        }
        for (const [id, socket] of sockets) {
            let app = this.apps.get(socket.name);
            if (!app) {
                app = {name: socket.name, rx: 0, tx: 0, rxRate: 0, txRate: 0};
                this.apps.set(socket.name, app);
            }
            const before = this.previous?.get(id);
            // First snapshot is a baseline. New sockets thereafter start at zero.
            const baseline = before?.name === socket.name ? before : {rx: 0, tx: 0};
            const rx = this.previous === null ? 0 : Math.max(0, socket.rx - baseline.rx);
            const tx = this.previous === null ? 0 : Math.max(0, socket.tx - baseline.tx);
            app.rx += rx;
            app.tx += tx;
            if (validRate) {
                app.rxRate += rx / elapsed;
                app.txRate += tx / elapsed;
            }
        }
        this.previous = sockets;
        this.lastTime = now;
    }

    top(limit = 5) {
        return [...this.apps.values()].filter(app => app.rx + app.tx > 0)
            .sort((a, b) => (b.rx + b.tx) - (a.rx + a.tx) || a.name.localeCompare(b.name))
            .slice(0, limit);
    }
}
