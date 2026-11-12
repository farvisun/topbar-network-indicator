// Transport-independent connection parsing and session accounting. No I/O here.
export const MAX_TARGETS = 2000;
export const PROXY_PROCESS = /^(throne(?:core)?|sing-box|mihomo|clash(?:-meta)?|xray|v2ray)$/i;

export function cleanText(value, limit = 253) {
    return typeof value === 'string'
        ? value.replace(/[\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]/g, '').slice(0, limit) : '';
}

export function normalizeIP(value) {
    let ip = cleanText(value, 80).replace(/^\[|\]$/g, '').split('%')[0].toLowerCase();
    if (ip.startsWith('::ffff:') && ip.slice(7).includes('.'))
        ip = ip.slice(7);
    if (/^\d+\.\d+\.\d+\.\d+$/.test(ip))
        return ip.split('.').map(Number).join('.');
    const words = ipv6Words(ip);
    if (words) {
        if (words.slice(0, 5).every(n => n === 0) && words[5] === 0xffff)
            return `${words[6] >> 8}.${words[6] & 255}.${words[7] >> 8}.${words[7] & 255}`;
        const full = words.map(w => w.toString(16)).join(':');
        const runs = [...full.matchAll(/(?:^|:)0(?::0)+(?:$|(?=:))/g)];
        const run = runs.sort((a, b) => b[0].length - a[0].length)[0];
        if (run) {
            const before = full.slice(0, run.index);
            const after = full.slice(run.index + run[0].length).replace(/^:/, '');
            return `${before}::${after}`;
        }
        return full;
    }
    return ip;
}

function ipv6Words(ip) {
    if (!ip.includes(':') || ip.split('::').length > 2)
        return null;
    if (ip.includes('.')) {
        const colon = ip.lastIndexOf(':');
        const bytes = ip.slice(colon + 1).split('.').map(Number);
        if (bytes.length !== 4 || bytes.some(n => !Number.isInteger(n) || n < 0 || n > 255))
            return null;
        ip = `${ip.slice(0, colon)}:${(bytes[0] * 256 + bytes[1]).toString(16)}:${(bytes[2] * 256 + bytes[3]).toString(16)}`;
    }
    const halves = ip.split('::');
    const left = halves[0] ? halves[0].split(':') : [];
    const right = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
    if ([...left, ...right].some(word => !/^[\da-f]{1,4}$/.test(word)) ||
        (halves.length === 1 ? left.length !== 8 : left.length + right.length >= 8))
        return null;
    return [...left, ...Array(8 - left.length - right.length).fill('0'), ...right].map(w => parseInt(w, 16));
}

// Avoid sending private, documentation, benchmark/fake-IP or multicast addresses
// to the location provider. An unreported IP stays unreported.
export function ipKind(value) {
    const ip = normalizeIP(value);
    if (!ip)
        return 'unknown';
    if (/^\d+\.\d+\.\d+\.\d+$/.test(ip)) {
        const [a, b, c, d] = ip.split('.').map(Number);
        if ([a, b, c, d].some(n => n > 255)) return 'unknown';
        if (a === 198 && (b === 18 || b === 19)) return 'virtual';
        if (a === 0 || a === 10 || a === 127 || a >= 224 ||
            (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
            (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) ||
            (a === 192 && b === 0 && (c === 0 || c === 2)) ||
            (a === 198 && b === 51 && c === 100) || (a === 203 && b === 0 && c === 113))
            return 'local';
        return 'public';
    }
    const words = ipv6Words(ip);
    if (!words) return 'unknown';
    if (words.slice(0, 5).every(n => n === 0) && words[5] === 0xffff)
        return ipKind(`${words[6] >> 8}.${words[6] & 255}.${words[7] >> 8}.${words[7] & 255}`);
    if ((words[0] & 0xe000) !== 0x2000 ||
        (words[0] === 0x2001 && (words[1] === 0xdb8 || words[1] < 0x200)) ||
        (words[0] === 0x3fff && words[1] < 0x1000))
        return 'local';
    return 'public';
}

export function splitEndpoint(value) {
    const text = cleanText(value, 100);
    const colon = text.lastIndexOf(':');
    return {ip: normalizeIP(colon < 0 ? text : text.slice(0, colon)),
        port: colon < 0 ? '' : text.slice(colon + 1)};
}

export function controllerURL(value) {
    const text = value.trim().replace(/\/+$/, '');
    // Controller credentials are only ever sent to an explicit loopback address.
    if (!/^http:\/\/(127\.0\.0\.1|localhost|\[::1\]):[1-9]\d{0,4}$/i.test(text))
        throw new Error('Use a local controller address such as http://127.0.0.1:9090');
    if (Number(text.slice(text.lastIndexOf(':') + 1)) > 65535)
        throw new Error('The controller port must be between 1 and 65535');
    return text;
}

const bytes = value => Number.isSafeInteger(value) && value >= 0 ? value : 0;

export function socketConnections(sockets, proxyConnected = false) {
    const result = new Map();
    for (const [id, socket] of sockets) {
        const {ip, port} = splitEndpoint(socket.peer);
        if (ipKind(ip) === 'unknown' || ip === '::1' || ip.startsWith('127.'))
            continue;
        const proxy = PROXY_PROCESS.test(socket.name);
        if (proxy && proxyConnected)
            continue;
        result.set(id, {id, host: '', ip, port, name: socket.name,
            network: 'TCP', route: proxy ? 'Proxy transport endpoint' : 'Direct socket',
            kind: proxy ? 'proxy-endpoint' : 'destination', rx: bytes(socket.rx), tx: bytes(socket.tx)});
    }
    return result;
}

export function parseProxyConnections(data, sockets = new Map()) {
    if (!data || !Array.isArray(data.connections))
        throw new Error('The controller did not return a connection list');
    const owners = new Map();
    for (const socket of sockets.values()) {
        const local = splitEndpoint(socket.local);
        owners.set(`${local.ip}:${local.port}`, socket.name);
    }
    const result = new Map();
    for (const item of data.connections.slice(0, 20000)) {
        if (!item || typeof item.id !== 'string' || !item.metadata)
            continue;
        const m = item.metadata;
        const host = cleanText(m.host || m.sniffHost).toLowerCase().replace(/\.$/, '');
        const ip = normalizeIP(m.destinationIP);
        if (!host && ipKind(ip) === 'unknown') continue;
        const sourceIP = normalizeIP(m.sourceIP);
        const sourcePort = String(m.sourcePort ?? '');
        // Joining the proxy source with the application's local socket also works
        // when sing-box cannot report process information for HTTP CONNECT.
        const path = cleanText(m.processPath || m.process, 512).split(/[\\/]/).pop();
        const name = owners.get(`${sourceIP}:${sourcePort}`) || path || 'App not reported';
        result.set(item.id, {id: item.id, host: ipKind(host) === 'unknown' ? host : '',
            ip: ip || (ipKind(host) !== 'unknown' ? host : ''),
            port: cleanText(String(m.destinationPort ?? ''), 5),
            name, network: cleanText(m.network || 'TCP', 12).toUpperCase(),
            route: Array.isArray(item.chains) ? item.chains.map(v => cleanText(v, 100)).join(' → ') : 'Proxy',
            kind: 'destination', rx: bytes(item.download), tx: bytes(item.upload)});
    }
    return result;
}

export function targetKey(connection) {
    return `${connection.kind === 'proxy-endpoint' ? 'proxy:' : ''}${connection.host ? 'host:' + connection.host : 'ip:' + connection.ip}`;
}

export class ConnectionTraffic {
    constructor() { this.reset(); }

    reset() {
        this.targets = new Map();
        this.streams = new Map();
        this.dropped = false;
    }

    disconnect(source) {
        this.streams.delete(source);
        for (const target of this.targets.values())
            target.rates.delete(source);
    }

    sample(source, connections, now) {
        const previous = this.streams.get(source);
        const elapsed = now - (previous?.time ?? now);
        const validRate = previous && elapsed > 0 && elapsed < 10;
        for (const target of this.targets.values())
            target.rates.delete(source);
        let evictable;
        for (const [id, connection] of connections) {
            const key = targetKey(connection);
            let target = this.targets.get(key);
            if (!target) {
                if (this.targets.size >= MAX_TARGETS) {
                    // Retain the busiest history, and make room for live targets.
                    if (!evictable) {
                        const activeKeys = new Set([...this.streams.values()].flatMap(s =>
                            [...s.connections.values()].map(targetKey)));
                        for (const value of connections.values()) activeKeys.add(targetKey(value));
                        evictable = [...this.targets.values()].filter(t => !activeKeys.has(t.key))
                            .sort((a, b) => b.rx + b.tx - a.rx - a.tx);
                    }
                    const oldest = evictable.pop();
                    if (oldest) this.targets.delete(oldest.key);
                    else { this.dropped = true; continue; }
                    this.dropped = true;
                }
                target = {key, host: connection.host, kind: connection.kind, rx: 0, tx: 0,
                    ips: new Map(), apps: new Set(), networks: new Set(), routes: new Set(), rates: new Map()};
                this.targets.set(key, target);
            }
            const before = previous?.connections.get(id);
            const baseline = before && targetKey(before) === key ? before : {rx: 0, tx: 0};
            // Existing connections on the first sample/reconnect are baselined.
            const sameTarget = !before || targetKey(before) === key;
            const rx = previous && sameTarget ? Math.max(0, connection.rx - baseline.rx) : 0;
            const tx = previous && sameTarget ? Math.max(0, connection.tx - baseline.tx) : 0;
            target.rx += rx;
            target.tx += tx;
            const rates = target.rates.get(source) ?? {rx: 0, tx: 0};
            if (validRate) { rates.rx += rx / elapsed; rates.tx += tx / elapsed; }
            target.rates.set(source, rates);
            if (connection.ip && target.ips.size < 32) target.ips.set(connection.ip, connection.port);
            if (target.apps.size < 32) target.apps.add(connection.name);
            if (target.networks.size < 8) target.networks.add(connection.network);
            if (target.routes.size < 16) target.routes.add(connection.route);
            target.lastSeen = now;
        }
        this.streams.set(source, {connections, time: now});
    }

    top(limit = 2000) {
        const active = new Map();
        const activeIPs = new Map();
        for (const stream of this.streams.values()) {
            for (const connection of stream.connections.values()) {
                const key = targetKey(connection);
                active.set(key, (active.get(key) ?? 0) + 1);
                if (!activeIPs.has(key)) activeIPs.set(key, new Set());
                activeIPs.get(key).add(connection.ip);
            }
        }
        return [...this.targets.values()].map(target => ({...target,
            active: active.get(target.key) ?? 0,
            activeIPs: activeIPs.get(target.key) ?? new Set(),
            rxRate: [...target.rates.values()].reduce((n, r) => n + r.rx, 0),
            txRate: [...target.rates.values()].reduce((n, r) => n + r.tx, 0),
        })).filter(t => t.rx + t.tx > 0 || t.active)
            .sort((a, b) => b.rx + b.tx - a.rx - a.tx || b.active - a.active || a.key.localeCompare(b.key))
            .slice(0, limit);
    }
}
