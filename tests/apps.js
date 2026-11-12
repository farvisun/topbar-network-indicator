import {AppTraffic, parseAppSockets} from '../apps.js';

function check(value, message) {
    if (!value)
        throw new Error(message);
}
const socket = (name, cookie, rx, tx, peer = '1.1.1.1:443') =>
    `ESTAB 0 0 192.168.1.2:12345 ${peer} users:(("${name}",pid=42,fd=7)) uid:1000 ino:11 sk:${cookie} cubic bytes_acked:${tx} bytes_received:${rx}`;
const parsed = parseAppSockets([
    socket('firefox', 'abc', 1000, 200),
    socket('local', 'def', 99999, 99999, '[::1]:8080'),
    socket('local', '123', 99999, 99999, '127.0.0.1:8080'),
    'ESTAB 0 0 192.168.1.2:12 1.1.1.1:443 sk:777 bytes_received:500',
].join('\n'));
check(parsed.size === 1 && parsed.get('abc').rx === 1000, 'Parse owned TCP sockets and exclude loopback');
const traffic = new AppTraffic();
traffic.sample(parsed, 1);
check(traffic.top().length === 0, 'Existing connections must start with a baseline');
traffic.sample(parseAppSockets(socket('firefox', 'abc', 3000, 1200)), 3);
check(traffic.top()[0].rx === 2000 && traffic.top()[0].rxRate === 1000, 'Measure deltas over actual elapsed time');
traffic.sample(parseAppSockets(socket('curl', '456', 10000, 100)), 4);
check(traffic.top()[0].name === 'curl' && traffic.top()[1].rxRate === 0, 'Rank session volume and retain closed app totals without stale rates');
traffic.sample(parseAppSockets(socket('curl', '456', 10, 1)), 5);
check(traffic.top()[0].rx === 10000, 'Counter resets cannot subtract traffic');
traffic.sample(parseAppSockets(socket('curl', '456', 1000, 1)), 30);
check(traffic.top()[0].rxRate === 0, 'No misleading speed after suspend');
traffic.reset();
traffic.sample(parsed, 31);
check(traffic.top().length === 0, 'Reset must clear totals and rebaseline');
print('App parsing, deltas, ranking, closed sockets, suspend and reset checks passed');
