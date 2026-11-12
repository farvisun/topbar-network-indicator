// Pure helpers shared by the extension and its GJS tests.
export function parseCounters(text) {
    const result = new Map();
    for (const line of text.split('\n')) {
        const colon = line.indexOf(':');
        if (colon < 0)
            continue;
        const name = line.slice(0, colon).trim();
        const fields = line.slice(colon + 1).trim().split(/\s+/);
        if (name === 'lo' || fields.length < 16)
            continue;
        const rx = Number(fields[0]);
        const tx = Number(fields[8]);
        if (Number.isFinite(rx) && Number.isFinite(tx) && rx >= 0 && tx >= 0)
            result.set(name, {rx, tx});
    }
    return result;
}

export function deltaCounters(previous, current, names) {
    let rx = 0;
    let tx = 0;
    for (const name of names) {
        const before = previous.get(name);
        const after = current.get(name);
        // A newly connected interface starts with a fresh baseline.
        if (!before || !after)
            continue;
        rx += Math.max(0, after.rx - before.rx);
        tx += Math.max(0, after.tx - before.tx);
    }
    return {rx, tx};
}

export function formatValue(bytes, bits = false, rate = true) {
    let value = Math.max(0, bytes) * (bits ? 8 : 1);
    const units = bits ? ['b', 'kb', 'Mb', 'Gb', 'Tb'] : ['B', 'kB', 'MB', 'GB', 'TB'];
    let unit = 0;
    while (value >= 1000 && unit < units.length - 1) {
        value /= 1000;
        unit++;
    }
    return `${value.toFixed(unit === 0 || value >= 100 ? 0 : 1)} ${units[unit]}${rate ? '/s' : ''}`;
}

// Three numeric characters and four unit characters keep panel geometry stable.
export function formatPanelValue(bytes, bits = false) {
    let value = Number.isFinite(bytes) ? Math.max(0, bytes) * (bits ? 8 : 1) : 0;
    const units = bits ? ['b/s', 'kb/s', 'Mb/s', 'Gb/s', 'Tb/s'] : ['B/s', 'kB/s', 'MB/s', 'GB/s', 'TB/s'];
    let unit = 0;
    while (Math.round(value) >= 1000 && unit < units.length - 1) {
        value /= 1000;
        unit++;
    }
    const number = unit > 0 && value < 9.95 ? value.toFixed(1) : String(Math.min(999, Math.round(value)));
    return `${number.padStart(3)} ${units[unit].padEnd(4)}`;
}
