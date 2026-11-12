import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

export const MINUTE = 60;
export const DAY = 86400;
export const VERSION = 1;
export const RETENTION_DAYS = [7, 30, 90, 365];
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const queues = new Map();

export function historyRoot() {
    return GLib.build_filenamev([GLib.get_user_data_dir(), 'topbar-network', 'history']);
}

function generationName(value) {
    if (!/^[a-zA-Z0-9-]+$/.test(value))
        throw new Error('Invalid history generation');
    return value;
}

export function dayName(time) {
    return new Date(time * 1000).toISOString().slice(0, 10);
}

// Split each observed interval into minute buckets. Integer remainders go to the
// final bucket so partitioning never creates or loses bytes.
export function splitInterval(start, end, rx, tx, config) {
    if (![start, end, rx, tx].every(Number.isFinite) || end <= start ||
        start < 0 || rx < 0 || tx < 0 || end - start > 10)
        return [];
    const rows = [];
    let allocatedRx = 0;
    let allocatedTx = 0;
    for (let from = start; from < end;) {
        const time = Math.floor(from / MINUTE) * MINUTE;
        const to = Math.min(end, time + MINUTE);
        const fraction = (to - start) / (end - start);
        const nextRx = to === end ? rx : Math.floor(rx * fraction);
        const nextTx = to === end ? tx : Math.floor(tx * fraction);
        rows.push({time, from, to, duration: to - from, rx: nextRx - allocatedRx,
            tx: nextTx - allocatedTx, config});
        allocatedRx = nextRx;
        allocatedTx = nextTx;
        from = to;
    }
    return rows;
}

export function mergeRows(...groups) {
    const merged = new Map();
    for (const rows of groups) {
        for (const row of rows) {
            const key = JSON.stringify([row.time, row.config]);
            const previous = merged.get(key);
            if (previous) {
                previous.from = Math.min(previous.from, row.from);
                previous.to = Math.max(previous.to, row.to);
                previous.duration += row.duration;
                previous.rx += row.rx;
                previous.tx += row.tx;
            } else {
                merged.set(key, {...row});
            }
        }
    }
    return [...merged.values()].sort((a, b) => a.time - b.time || a.config.localeCompare(b.config));
}

export function decodeDay(text) {
    const value = JSON.parse(text);
    if (value.version !== VERSION || !Array.isArray(value.rows))
        throw new Error('Unsupported history format');
    for (const row of value.rows) {
        if (![row.time, row.from, row.to, row.duration, row.rx, row.tx].every(Number.isFinite) ||
            row.time < 0 || row.time % MINUTE !== 0 || row.from < row.time ||
            row.to > row.time + MINUTE || row.to <= row.from || row.duration <= 0 ||
            row.rx < 0 || row.tx < 0 || typeof row.config !== 'string')
            throw new Error('Invalid history record');
    }
    return value.rows;
}

// Queries use half-open UTC ranges. Partial minutes are prorated; saved history
// has minute resolution. Rates divide by observed time, not unobserved gaps.
export function queryRows(rows, start, end, count = 120) {
    const step = (end - start) / count;
    if (!(step > 0) || count < 1)
        throw new Error('Invalid history range');
    const points = Array.from({length: count}, (_, i) => ({
        time: start + i * step, end: start + (i + 1) * step,
        rx: 0, tx: 0, duration: 0, configs: [],
    }));
    let rx = 0;
    let tx = 0;
    for (const row of rows) {
        const from = Math.max(start, row.from);
        const to = Math.min(end, row.to);
        if (to <= from)
            continue;
        rx += row.rx * (to - from) / (row.to - row.from);
        tx += row.tx * (to - from) / (row.to - row.from);
        const first = Math.max(0, Math.floor((from - start) / step));
        const last = Math.min(count - 1, Math.ceil((to - start) / step) - 1);
        for (let i = first; i <= last; i++) {
            const point = points[i];
            const fraction = Math.max(0, Math.min(to, point.end) - Math.max(from, point.time)) / (row.to - row.from);
            point.rx += row.rx * fraction;
            point.tx += row.tx * fraction;
            point.duration += row.duration * fraction;
            if (!point.configs.includes(row.config))
                point.configs.push(row.config);
        }
    }
    for (const point of points) {
        point.rx = point.duration ? point.rx / point.duration : 0;
        point.tx = point.duration ? point.tx / point.duration : 0;
    }
    return {start, end, points, rx, tx};
}

export function exportCsv(rows, start, end) {
    const quote = value => `"${String(value).replaceAll('"', '""')}"`;
    const lines = ['timestamp_utc,observed_seconds,received_bytes,sent_bytes,interface_configuration'];
    for (const row of rows) {
        const from = Math.max(start, row.from);
        const to = Math.min(end, row.to);
        if (to <= from)
            continue;
        const fraction = (to - from) / (row.to - row.from);
        lines.push([new Date(from * 1000).toISOString(), row.duration * fraction,
            row.rx * fraction, row.tx * fraction, quote(row.config)].join(','));
    }
    return `${lines.join('\n')}\n`;
}

export function loadText(file) {
    return new Promise((resolve, reject) => file.load_contents_async(null, (source, result) => {
        try {
            const [, bytes] = source.load_contents_finish(result);
            resolve(decoder.decode(bytes));
        } catch (error) {
            reject(error);
        }
    }));
}

export function replaceText(file, text) {
    return new Promise((resolve, reject) => file.replace_contents_async(encoder.encode(text),
        null, false, Gio.FileCreateFlags.PRIVATE | Gio.FileCreateFlags.REPLACE_DESTINATION,
        null, (source, result) => {
            try {
                source.replace_contents_finish(result);
                resolve();
            } catch (error) {
                reject(error);
            }
        }));
}

async function children(directory) {
    let enumerator;
    try {
        enumerator = await new Promise((resolve, reject) => directory.enumerate_children_async(
            'standard::name,standard::type', Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS,
            GLib.PRIORITY_DEFAULT, null, (source, result) => {
                try { resolve(source.enumerate_children_finish(result)); } catch (error) { reject(error); }
            }));
    } catch (error) {
        if (error.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND))
            return [];
        throw error;
    }
    const entries = [];
    try {
        while (true) {
            const batch = await new Promise((resolve, reject) => enumerator.next_files_async(
                64, GLib.PRIORITY_DEFAULT, null, (source, result) => {
                    try { resolve(source.next_files_finish(result)); } catch (error) { reject(error); }
                }));
            if (!batch.length)
                return entries;
            entries.push(...batch);
        }
    } finally {
        await new Promise(resolve => enumerator.close_async(GLib.PRIORITY_DEFAULT, null,
            (source, result) => { try { source.close_finish(result); } finally { resolve(); } }));
    }
}

async function remove(file) {
    try {
        await new Promise((resolve, reject) => file.delete_async(GLib.PRIORITY_DEFAULT, null, (source, result) => {
            try { source.delete_finish(result); resolve(); } catch (error) { reject(error); }
        }));
    } catch (error) {
        if (!error.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND))
            throw error;
    }
}

async function removeTree(directory) {
    for (const info of await children(directory)) {
        const child = directory.get_child(info.get_name());
        if (info.get_file_type() === Gio.FileType.DIRECTORY)
            await removeTree(child);
        else
            await remove(child);
    }
    await remove(directory);
}

function serial(root, operation) {
    const previous = queues.get(root) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(operation);
    queues.set(root, next);
    // Keep operations from consecutive extension lifecycles in order.
    next.finally(() => { if (queues.get(root) === next) queues.delete(root); }).catch(() => {});
    return next;
}

export class HistoryStore {
    constructor({root = historyRoot(), generation = () => 'initial', retention = () => 365,
        onStatus = () => {}} = {}) {
        this.root = root;
        this.generation = generation;
        this.retention = retention;
        this.onStatus = onStatus;
        this._generation = generationName(generation());
        this._pending = [];
        this._inflight = [];
        this.status = '';
    }

    _syncGeneration() {
        const current = generationName(this.generation());
        if (current !== this._generation) {
            this._generation = current;
            this._pending = [];
            this._inflight = [];
            this.status = '';
        }
        return current;
    }

    _status(message) {
        this.status = message;
        this.onStatus(message);
    }

    add(start, end, rx, tx, config) {
        this._syncGeneration();
        for (const row of splitInterval(start, end, rx, tx, config)) {
            const previous = this._pending.findLast(item => item.time === row.time && item.config === row.config);
            if (previous) {
                previous.from = Math.min(previous.from, row.from);
                previous.to = Math.max(previous.to, row.to);
                previous.duration += row.duration;
                previous.rx += row.rx;
                previous.tx += row.tx;
            } else {
                this._pending.push(row);
            }
        }
    }

    async _read(file) {
        try {
            return decodeDay(await loadText(file));
        } catch (error) {
            if (error.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND))
                return [];
            throw error;
        }
    }

    _write(file, text) {
        return replaceText(file, text);
    }

    flush() {
        return serial(this.root, async () => {
            const generation = this._syncGeneration();
            const cutoff = Date.now() / 1000 - this.retention() * DAY;
            const pending = this._pending.filter(row => row.to > cutoff);
            this._pending = [];
            this._inflight = pending;
            const directory = Gio.File.new_for_path(GLib.build_filenamev([this.root, generation]));
            try {
                // Directory creation is tiny; file content IO stays asynchronous.
                if (GLib.mkdir_with_parents(directory.get_path(), 0o700) !== 0)
                    throw new Error('Cannot create history directory');
                const days = new Map();
                for (const row of pending) {
                    const day = dayName(row.time);
                    if (!days.has(day)) days.set(day, []);
                    days.get(day).push(row);
                }
                let failed = false;
                for (const [day, rows] of days) {
                    if (generation !== this.generation())
                        break;
                    const file = directory.get_child(`${day}.json`);
                    let saved;
                    try {
                        saved = await this._read(file);
                    } catch (error) {
                        // Never overwrite malformed or unreadable history.
                        failed = true;
                        continue;
                    }
                    if (generation !== this.generation())
                        break;
                    await this._write(file, JSON.stringify({version: VERSION, rows: mergeRows(saved, rows)}));
                    // If preferences cleared history during a write, remove the
                    // old file. The new generation can never read this write.
                    if (generation !== this.generation())
                        await remove(file);
                    this._inflight = this._inflight.filter(row => dayName(row.time) !== day);
                }
                if (generation === this.generation()) {
                    this._pending = mergeRows(this._inflight, this._pending);
                    this._status(failed ? 'Some history could not be saved; an existing file is unreadable' : '');
                }
            } catch (error) {
                if (generation === this.generation()) {
                    this._pending = mergeRows(this._inflight, this._pending);
                    this._status('History could not be saved; collection continues');
                }
            } finally {
                this._inflight = [];
                this._syncGeneration();
            }
        });
    }

    readRange(start, end) {
        return serial(this.root, () => this._readRange(start, end));
    }

    async _readRange(start, end) {
        const generation = this._syncGeneration();
        const cutoff = Date.now() / 1000 - this.retention() * DAY;
        start = Math.max(start, cutoff);
        end = Math.min(end, Date.now() / 1000);
        let rows = [];
        let warning = '';
        if (end > start) {
            const directory = Gio.File.new_for_path(GLib.build_filenamev([this.root, generation]));
            for (let time = Math.floor(start / DAY) * DAY; time < end; time += DAY) {
                if (generation !== this.generation())
                    break;
                const name = `${dayName(time)}.json`;
                try {
                    rows.push(...await this._read(directory.get_child(name)));
                } catch {
                    warning = `Some history is unreadable (${name})`;
                }
            }
        }
        if (generation !== this.generation())
            return {rows: [], warning: 'History cleared; refresh to view new data'};
        // Snapshot pending after IO, including samples collected during loading.
        rows = mergeRows(rows, this._pending).filter(row => row.to > start && row.from < end);
        return {rows, warning};
    }

    prune(now = Date.now() / 1000) {
        return serial(this.root, async () => {
            this._syncGeneration();
            const root = Gio.File.new_for_path(this.root);
            const cutoff = now - this.retention() * DAY;
            this._pending = this._pending.filter(row => row.to > cutoff);
            try {
                for (const info of await children(root)) {
                    if (info.get_file_type() !== Gio.FileType.DIRECTORY)
                        continue;
                    const name = info.get_name();
                    const directory = root.get_child(name);
                    if (name !== this.generation()) {
                        await removeTree(directory);
                        continue;
                    }
                    for (const entry of await children(directory)) {
                        if (!/^\d{4}-\d{2}-\d{2}\.json$/.test(entry.get_name()))
                            continue;
                        const file = directory.get_child(entry.get_name());
                        const day = Date.parse(entry.get_name().slice(0, 10)) / 1000;
                        if (day + DAY <= cutoff) {
                            await remove(file);
                        } else if (day < cutoff) {
                            const rows = await this._read(file);
                            // Keep the boundary minute for minute-resolution queries.
                            await replaceText(file, JSON.stringify({version: VERSION,
                                rows: rows.filter(row => row.to > cutoff)}));
                        }
                    }
                }
            } catch {
                this._status('Some old history could not be removed');
            }
        });
    }
}

// Use calendar arithmetic rather than 86400-second days: local days can cross
// DST changes. Weeks start on Monday; returned end is exclusive.
export function calendarRange(anchor, mode, offset = 0) {
    const from = new Date(anchor.getFullYear(), anchor.getMonth(), anchor.getDate());
    if (mode === 'month') {
        from.setDate(1);
        from.setMonth(from.getMonth() + offset);
    } else if (mode === 'week') {
        from.setDate(from.getDate() - (from.getDay() + 6) % 7 + offset * 7);
    } else {
        from.setDate(from.getDate() + offset);
    }
    const to = new Date(from);
    if (mode === 'month') to.setMonth(to.getMonth() + 1);
    else to.setDate(to.getDate() + (mode === 'week' ? 7 : 1));
    return {start: from.getTime() / 1000, end: to.getTime() / 1000};
}
