import Cairo from 'cairo';
import Gio from 'gi://Gio';
import {parseAppSockets} from '../apps.js';
import {ConnectionTraffic, parseProxyConnections, socketConnections, ipKind, normalizeIP,
    controllerURL, MAX_TARGETS} from '../connections.js';
import {project, connectionArcs, drawWorldMap, mapPoints, hitTest} from '../worldMap.js';
import {parseLocation} from '../connectionMonitor.js';

function check(value, message) { if (!value) throw new Error(message); }
function rejects(fn, message) {
    let rejected = false;
    try { fn(); } catch { rejected = true; }
    check(rejected, message);
}
const api = (id, host, rx, tx, extra = {}) => ({id, download: rx, upload: tx,
    metadata: {host, destinationIP: '1.1.1.1', destinationPort: '443', sourceIP: '127.0.0.1',
        sourcePort: '45000', network: 'tcp', processPath: '/opt/Throne/ThroneCore', ...extra}, chains: ['proxy']});
const parse = connections => parseProxyConnections({connections});
const sockets = parseAppSockets([
    'ESTAB 0 0 127.0.0.1:45000 127.0.0.1:2080 users:(("firefox",pid=2,fd=3)) sk:a bytes_received:100 bytes_acked:20',
    'ESTAB 0 0 192.168.1.2:50000 8.8.8.8:443 users:(("ThroneCore",pid=3,fd=4)) sk:b bytes_received:1000 bytes_acked:100',
    'ESTAB 0 0 [::ffff:127.0.0.1]:45001 [::ffff:127.0.0.1]:2080 users:(("curl",pid=4,fd=5)) sk:c bytes_received:2',
].join('\n'), {includeLoopback: true});
check(sockets.size === 3, 'Keep loopback sockets for source-app matching');
const owned = parseProxyConnections({connections: [api('a', 'EXAMPLE.COM.', 100, 50)]}, sockets).get('a');
check(owned.name === 'firefox' && owned.host === 'example.com', 'Recover HTTP proxy app from the source socket and normalize domain');
const mapped = parseProxyConnections({connections: [api('a', 'test.example', 0, 0,
    {sourceIP: '0:0:0:0:0:ffff:7f00:1', sourcePort: '45001'})]}, sockets);
check(mapped.get('a').name === 'curl', 'Normalize IPv4 mapped source addresses for matching');
check(socketConnections(sockets).size === 1 && socketConnections(sockets, true).size === 0,
    'Exclude loopback and hide proxy transport sockets when the target API is connected');
check(socketConnections(sockets).get('b').kind === 'proxy-endpoint', 'Disconnected API fallback labels proxy endpoints honestly');
rejects(() => parseProxyConnections({error: 'not found'}), 'Reject endpoints that are not a Clash connection feed');
check(parse([{}, null, {id: 'no metadata'}, api('a', 'test\n\u202e.example', -100, NaN)]).get('a').rx === 0,
    'Malformed entries and counters do not poison accounting');

for (const ip of ['127.0.0.1', '::1', '10.0.0.1', '172.31.1.1', '192.168.2.3',
    '100.64.0.1', '169.254.1.1', '224.0.0.1', '255.255.255.255', '2001:db8::1',
    'fc00::1', 'fe80::1%eth0', '::ffff:c0a8:1', '198.51.100.1', '203.0.113.1'])
    check(ipKind(ip) === 'local', `${ip} must not be sent for geolocation`);
for (const ip of ['1.1.1.1', '8.8.8.8', '2606:4700:4700::1111', '2001:4860:4860::8888'])
    check(ipKind(ip) === 'public', `${ip} is a valid public IP`);
check(ipKind('198.18.0.1') === 'virtual' && ipKind('198.19.255.255') === 'virtual', 'Recognize proxy fake-IP range');
for (const ip of ['', 'example.com', '999.2.3.4', '2001:::1', '1:2:3', 'a/b'])
    check(ipKind(ip) === 'unknown', `Reject invalid IP ${ip}`);
check(normalizeIP('0:0:0:0:0:0:0:1') === '::1', 'Canonicalize expanded loopback');
check(normalizeIP('[2001:0db8:0000:0001::0001]') === '2001:db8:0:1::1', 'Canonicalize IPv6 longest zero run');
for (const url of ['http://127.0.0.1:9090', 'http://[::1]:9090', 'http://localhost:9090/'])
    check(controllerURL(url).endsWith('9090'), 'Accept loopback controllers');
for (const url of ['https://remote.example:9090', 'http://127.0.0.1:9090@evil.example',
    'http://127.0.0.1:65536', 'http://127.0.0.1:9090/path', 'http://192.168.1.2:9090'])
    rejects(() => controllerURL(url), 'Never send controller credentials to non-loopback URLs');

const traffic = new ConnectionTraffic();
traffic.sample('proxy', parse([api('a', 'example.com', 10000, 1000), api('b', 'example.com', 100, 10)]), 1);
check(traffic.top()[0].rx === 0 && traffic.top()[0].active === 2, 'Initial counters are baselined, active destinations remain visible');
traffic.sample('proxy', parse([api('a', 'example.com', 12000, 1500), api('b', 'example.com', 500, 110)]), 3);
let top = traffic.top()[0];
check(top.rx === 2400 && top.tx === 600 && top.rxRate === 1200, 'Group domain connections and use elapsed time');
traffic.sample('proxy', parse([api('c', 'other.example', 10000, 100)]), 4);
top = traffic.top();
check(top[0].host === 'other.example' && top[1].rxRate === 0 && !top[1].active, 'Rank new connections and retain closed totals without stale activity');
traffic.sample('proxy', parse([api('c', 'other.example', 10, 1)]), 5);
check(traffic.top()[0].rx === 10000, 'Counter rollback never subtracts bytes');
traffic.sample('proxy', parse([api('c', 'other.example', 100, 10)]), 30);
check(traffic.top()[0].rxRate === 0, 'Suspend produces no misleading rate');
traffic.disconnect('proxy');
check(traffic.top()[0].active === 0 && traffic.top()[0].rxRate === 0, 'A failed controller clears active counts and rates');
traffic.sample('proxy', parse([api('c', 'other.example', 100000, 10000)]), 31);
check(traffic.top()[0].rx === 10090, 'A reconnect rebaselines counters without adding unavailable traffic');
traffic.sample('proxy', parse([api('c', 'changed.example', 101000, 10100)]), 32);
check(traffic.top().find(t => t.host === 'changed.example').rx === 0, 'A changed host on a reused ID starts from a fresh baseline');
traffic.reset();
traffic.sample('proxy', parse([api('a', 'example.com', 100, 10)]), 33);
check(traffic.top()[0].rx === 0, 'Reset clears history and baseline');
const many = Array.from({length: MAX_TARGETS + 10}, (_, i) => api(String(i), `target${i}.example`, 0, 0));
traffic.sample('proxy', parse(many), 34);
check(traffic.targets.size === MAX_TARGETS && traffic.dropped, 'Session memory is bounded and reports truncation');

const geo = {success: true, country: 'United States', country_code: 'US', latitude: 37.4, longitude: -122.1};
check(parseLocation(geo).country === 'United States', 'Parse approximate location');
check(!parseLocation({...geo, success: false}) && !parseLocation({...geo, latitude: 500}), 'Reject missing and invalid coordinates');
check(project(0, 0, 720, 360).join(',') === '360,180', 'Project longitude and latitude consistently');
const arcs = connectionArcs({longitude: 170, latitude: 30}, {longitude: -170, latitude: 40}, 720, 360);
check(arcs.every(a => Math.abs(a[6] - a[0]) < 80), 'Pacific links wrap across the antimeridian');
const targets = [{key: 'test', active: 1, rx: 10, tx: 5, endpoints: [{geo: parseLocation(geo), estimated: true}]}];
const points = mapPoints(targets, 720, 360);
check(hitTest(points, points[0].x, points[0].y) === 'test' && hitTest(points, 0, 0) === null, 'Map markers can be selected');
const surface = new Cairo.ImageSurface(Cairo.Format.ARGB32, 720, 360);
const cr = new Cairo.Context(surface);
const [, content] = Gio.File.new_for_path('data/world-land.geojson').load_contents(null);
const land = JSON.parse(new TextDecoder().decode(content));
drawWorldMap(cr, 720, 360, land, targets, {longitude: 51, latitude: 35}, 'test');
surface.writeToPNG('/tmp/topbar-network-world-map.png');
drawWorldMap(cr, 720, 360, land, [], null, null);
cr.$dispose();
print('Connections: proxy attribution, IPv4/IPv6, privacy, accounting, lifecycle, limits and offline map rendering passed');
