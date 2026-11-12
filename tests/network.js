import {parseCounters, deltaCounters, formatValue, formatPanelValue} from '../network.js';

function equal(actual, expected, message) {
    if (JSON.stringify(actual) !== JSON.stringify(expected))
        throw new Error(`${message}: got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);
}

const line = (name, rx, tx) => `${name}: ${rx} 0 0 0 0 0 0 0 ${tx} 0 0 0 0 0 0 0`;
const before = parseCounters([line('lo', 10000, 10000), line('eth0', 1000, 2000)].join('\n'));
equal([...before.keys()], ['eth0'], 'Loopback excluded');
const after = parseCounters([line('eth0', 3000, 2500), line('tun0', 8000, 9000)].join('\n'));
equal(deltaCounters(before, after, ['eth0']), {rx: 2000, tx: 500}, 'Traffic deltas');
equal(deltaCounters(before, after, ['eth0', 'tun0']), {rx: 2000, tx: 500}, 'New interface baseline');
equal(deltaCounters(after, before, ['eth0']), {rx: 0, tx: 0}, 'Counter reset');
equal(deltaCounters(after, new Map(), ['eth0']), {rx: 0, tx: 0}, 'Disconnected interface');
equal(parseCounters('bad: nope\neth0: garbage 0 0 0 0 0 0 0 bad 0 0 0 0 0 0 0').size, 0, 'Malformed counters');
equal(formatValue(1500), '1.5 kB/s', 'Byte speed');
equal(formatValue(125000, true), '1.0 Mb/s', 'Bit speed');
equal(formatValue(2000000, false, false), '2.0 MB', 'Session total');
equal(formatValue(0), '0 B/s', 'Idle');
print('10 network checks passed');

equal(formatPanelValue(0), '  0 B/s ', 'Fixed idle fields');
equal(formatPanelValue(1500), '1.5 kB/s', 'Three-character decimal');
equal(formatPanelValue(9950), ' 10 kB/s', 'Rounded decimal fits');
equal(formatPanelValue(999500), '1.0 MB/s', 'Rounding promotes unit');
for (const bits of [false, true]) {
    for (const value of [0, 1, 999, 999.9, 1000, 9949, 9950, 999499, 999500, 1e18]) {
        const formatted = formatPanelValue(value, bits);
        equal(formatted.length, 8, 'Panel fields have constant width');
        equal(formatted.slice(0, 3).trim().length <= 3, true, 'Number fits three characters');
    }
}
print('Fixed panel number and unit checks passed');
