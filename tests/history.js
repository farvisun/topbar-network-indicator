import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import {HistoryStore, MINUTE, DAY, VERSION, splitInterval, mergeRows, queryRows,
    decodeDay, dayName, exportCsv, calendarRange, loadText, replaceText} from '../history.js';

function check(value, message) {
    if (!value) throw new Error(message);
}
function near(actual, expected, message) {
    check(Math.abs(actual - expected) < 0.0001, `${message}: ${actual} != ${expected}`);
}
function throws(operation, message) {
    let thrown = false;
    try { operation(); } catch { thrown = true; }
    check(thrown, message);
}
function removeTree(file) {
    if (file.query_file_type(Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, null) === Gio.FileType.DIRECTORY) {
        const enumerator = file.enumerate_children('standard::name', Gio.FileQueryInfoFlags.NONE, null);
        let info;
        while ((info = enumerator.next_file(null))) removeTree(file.get_child(info.get_name()));
        enumerator.close(null);
    }
    file.delete(null);
}

const split = splitInterval(58, 63, 101, 37, 'Automatic: eth0');
check(split.length === 2 && split[0].time === 0 && split[1].time === 60, 'Split minute boundary');
near(split.reduce((sum, r) => sum + r.rx, 0), 101, 'Exact received bytes');
near(split.reduce((sum, r) => sum + r.tx, 0), 37, 'Exact sent bytes');
near(split.reduce((sum, r) => sum + r.duration, 0), 5, 'Exact observed duration');
check(splitInterval(1, 50, 100, 100, 'eth0').length === 0, 'Do not invent observations over suspend');
check(splitInterval(5, 4, 10, 10, 'eth0').length === 0, 'Reject backward clock');
check(splitInterval(1, 2, NaN, 10, 'eth0').length === 0, 'Reject invalid counters');
const merged = mergeRows(split, splitInterval(63, 65, 40, 20, 'Automatic: eth0'));
near(merged[1].duration, 5, 'Merge minute durations');
near(queryRows(merged, 0, 120, 2).rx, 141, 'Queries preserve total bytes');
const partial = queryRows(splitInterval(61, 66, 100, 50, 'eth0'), 61, 66, 5);
near(partial.rx, 100, 'Partial current minute includes all collected bytes');
near(partial.points[0].rx, 20, 'Rate based on observed seconds');
const gaps = queryRows(splitInterval(0, 5, 100, 0, 'eth0'), 0, 180, 3);
check(gaps.points[0].duration === 5 && gaps.points[1].duration === 0 && gaps.points[2].duration === 0,
    'Missing buckets stay gaps');
check(mergeRows(split, splitInterval(63, 65, 1, 1, 'tun0')).length === 3, 'Keep interface configurations distinct');
const csv = exportCsv(splitInterval(61, 66, 100, 50, 'Automatic: eth0, "wireless"'), 0, 120);
check(csv.includes('"Automatic: eth0, ""wireless"""'), 'CSV escapes quotes and commas');
check(csv.includes('1970-01-01T00:01:01.000Z,5,100,50'), 'CSV contains UTC timestamp, duration and bytes');
throws(() => decodeDay('{'), 'Reject malformed JSON');
throws(() => decodeDay('{"version":999,"rows":[]}'), 'Reject unsupported version');
throws(() => decodeDay(JSON.stringify({version: VERSION, rows: [{...split[0], duration: -1}]})), 'Reject invalid rows');
check(decodeDay(JSON.stringify({version: VERSION, rows: split})).length === 2, 'Decode valid data');

const january = calendarRange(new Date(2026, 0, 31), 'month', 1);
check(new Date(january.start * 1000).getMonth() === 1 && new Date(january.start * 1000).getDate() === 1, 'Month navigation cannot skip February');
const week = calendarRange(new Date(2026, 10, 15), 'week');
check(new Date(week.start * 1000).getDay() === 1, 'Weeks start Monday');
const dst = calendarRange(new Date(2026, 2, 8), 'day');
check(new Date(dst.end * 1000).getDate() === 9, 'Calendar days end at next local midnight across DST');
if (GLib.getenv('TZ') === 'America/New_York') near(dst.end - dst.start, 23 * 3600, 'Spring DST day is 23 hours');

const root = GLib.dir_make_tmp('topbar-network-history-XXXXXX');
let generation = 'initial';
let retention = 365;
const options = {root, generation: () => generation, retention: () => retention};
const now = Math.floor(Date.now() / 1000 / MINUTE) * MINUTE - 120;
try {
    const store = new HistoryStore(options);
    store.add(now, now + 5, 500, 100, 'eth0');
    near(queryRows((await store.readRange(now, now + 60)).rows, now, now + 60).rx, 500, 'Query unsaved pending samples');
    await store.flush();
    check(!store.status, 'Successful write has no error');
    const restored = new HistoryStore(options);
    near(queryRows((await restored.readRange(now, now + 60)).rows, now, now + 60).rx, 500, 'Restore across lifecycle');
    store.add(now + 5, now + 10, 300, 100, 'eth0');
    await Promise.all([store.flush(), store.flush()]);
    near(queryRows((await restored.readRange(now, now + 60)).rows, now, now + 60).rx, 800, 'Serialized flush never double-counts');

    // Disable's final write and immediate enable's first write share a queue.
    store.add(now + 10, now + 15, 200, 50, 'eth0');
    const finalWrite = store.flush();
    restored.add(now + 15, now + 20, 400, 50, 'eth0');
    await Promise.all([finalWrite, restored.flush()]);
    near(queryRows((await restored.readRange(now, now + 60)).rows, now, now + 60).rx, 1400, 'Lifecycle writes merge without overwriting');

    const file = Gio.File.new_for_path(`${root}/${generation}/${dayName(now)}.json`);
    const saved = await loadText(file);
    await replaceText(file, '{corrupt');
    const damaged = await restored.readRange(now, now + 60);
    check(damaged.warning && !damaged.rows.length, 'Corrupt file yields warning without crashing');
    restored.add(now + 20, now + 25, 100, 10, 'eth0');
    await restored.flush();
    check(restored.status && await loadText(file) === '{corrupt', 'Never overwrite corrupt history');
    restored.add(now - DAY, now - DAY + 5, 200, 20, 'eth0');
    await restored.flush();
    near(queryRows((await restored.readRange(now - DAY, now - DAY + 60)).rows, now - DAY, now - DAY + 60).rx,
        200, 'One corrupt day cannot block other dates from saving');
    await replaceText(file, saved);
    await restored.flush();
    near(queryRows((await restored.readRange(now, now + 60)).rows, now, now + 60).rx, 1500, 'Retry preserves pending bytes after IO failure');

    const originalWrite = restored._write.bind(restored);
    restored._write = async () => { throw new Error('disk full'); };
    restored.add(now + 25, now + 30, 75, 5, 'eth0');
    await restored.flush();
    check(restored.status, 'Disk failure is visible');
    restored._write = originalWrite;
    await restored.flush();
    near(queryRows((await restored.readRange(now, now + 60)).rows, now, now + 60).rx, 1575, 'Retry after disk failure keeps byte totals');

    // Change generation while replace is in flight, as a separate preferences process would.
    let release;
    const barrier = new Promise(resolve => { release = resolve; });
    let entered;
    const started = new Promise(resolve => { entered = resolve; });
    restored._write = async (target, text) => { entered(); await barrier; return originalWrite(target, text); };
    restored.add(now + 30, now + 35, 99, 9, 'eth0');
    const writing = restored.flush();
    await started;
    generation = 'cleared';
    release();
    await writing;
    await restored.prune();
    check(!(await restored.readRange(now, now + 60)).rows.length, 'Clear during pending write cannot resurrect records');
    check(!Gio.File.new_for_path(`${root}/initial`).query_exists(null), 'Old generation is physically deleted');
    restored._write = originalWrite;
    restored.add(now + 35, now + 40, 50, 5, 'tun0');
    await restored.flush();
    near(queryRows((await restored.readRange(now, now + 60)).rows, now, now + 60).rx, 50, 'Collection continues after clear');

    const old = now - 40 * DAY;
    restored.add(old, old + 5, 123, 45, 'eth0');
    await restored.flush();
    check(Gio.File.new_for_path(`${root}/${generation}/${dayName(old)}.json`).query_exists(null), 'Old day written');
    retention = 7;
    await restored.prune();
    check(!Gio.File.new_for_path(`${root}/${generation}/${dayName(old)}.json`).query_exists(null), 'Retention removes expired files');
    near(queryRows((await restored.readRange(now, now + 60)).rows, now, now + 60).rx, 50, 'Retention preserves recent history');
    check(!(await restored.readRange(old, old + 60)).rows.length, 'Expired history unavailable in queries');
    print('History aggregation, dates, CSV, persistence, corruption, IO retry, lifecycle, clear races and retention checks passed');
} finally {
    removeTree(Gio.File.new_for_path(root));
}
