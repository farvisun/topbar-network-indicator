import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Soup from 'gi://Soup?version=3.0';
import {ConnectionMonitor} from '../connectionMonitor.js';

function check(value, message) { if (!value) throw new Error(message); }
function sleep(ms) { return new Promise(resolve => GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms,
    () => { resolve(); return GLib.SOURCE_REMOVE; })); }
const schemaSource = Gio.SettingsSchemaSource.new_from_directory(`${GLib.get_current_dir()}/schemas`,
    Gio.SettingsSchemaSource.get_default(), false);
const settings = new Gio.Settings({settings_schema: schemaSource.lookup('org.gnome.shell.extensions.topbar-network', false)});
settings.set_boolean('geolocation-enabled', false);
settings.set_boolean('resolve-domains', false);
let downloaded = 100;
let response = 200;
let authenticated = false;
let delay = false;
const server = new Soup.Server();
server.add_handler('/connections', (_server, message) => {
    authenticated = message.get_request_headers().get_one('Authorization') === 'Bearer integration-test-token';
    const finish = () => {
        if (response === 302) message.set_redirect(302, 'http://127.0.0.1:1/should-never-be-requested');
        else {
            message.set_status(response, null);
            message.set_response('application/json', Soup.MemoryUse.COPY, JSON.stringify({connections: [{
                id: 'one', download: downloaded, upload: 10,
                metadata: {host: 'example.com', destinationIP: '1.1.1.1', destinationPort: '443', network: 'tcp'},
                chains: ['proxy'],
            }]}));
        }
    };
    if (delay) {
        message.pause();
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 50, () => { finish(); message.unpause(); return GLib.SOURCE_REMOVE; });
    } else finish();
});
server.listen_local(0, Soup.ServerListenOptions.IPV4_ONLY);
settings.set_string('proxy-controller', server.get_uris()[0].to_string().replace(/\/$/, ''));
let notifications = 0;
const monitor = new ConnectionMonitor(settings, () => notifications++);
monitor._secret = 'integration-test-token';
try {
    await monitor.poll();
    check(authenticated && monitor.proxyConnected, 'Read the authenticated local connection API');
    check(monitor.snapshot().targets[0].rx === 0, 'Baseline existing API counters');
    downloaded = 5100;
    await monitor.poll();
    check(monitor.snapshot().targets[0].rx === 5000, 'Collect per-domain traffic from HTTP responses');
    const transport = new Map([['transport', {name: 'ThroneCore', local: '192.168.1.2:45000',
        peer: '8.8.8.8:443', rx: 1000000, tx: 100000}]]);
    monitor.updateSockets(transport, 1);
    response = 401;
    await monitor.poll();
    check(!monitor.proxyConnected && monitor.status.includes('authentication') && !monitor.snapshot().targets[0].active,
        'Authentication errors produce a status and clear stale activity');
    monitor.updateSockets(transport, 2);
    check(monitor.snapshot().targets.find(t => t.kind === 'proxy-endpoint').rx === 0,
        'API failure never adds old lifetime transport counters to destination totals');
    response = 200;
    downloaded = 50000;
    monitor._nextPoll = 0;
    await monitor.poll();
    check(monitor.snapshot().targets[0].rx === 5000, 'Reconnect omits the unobserved interval');
    response = 302;
    await monitor.poll();
    check(!monitor.proxyConnected, 'Controller redirects are refused');
    settings.set_string('proxy-controller', 'http://remote.example:9090');
    monitor.configure();
    await monitor.poll();
    check(!monitor.proxyConnected && monitor.status.includes('local controller'), 'Invalid controller settings disable API requests');
    settings.set_string('proxy-controller', server.get_uris()[0].to_string().replace(/\/$/, ''));
    monitor.configure();
    monitor._secret = 'integration-test-token';
    response = 200;
    delay = true;
    const request = monitor.poll();
    await sleep(10);
    monitor.close();
    const before = notifications;
    await request;
    await sleep(70);
    check(notifications === before && monitor._closed, 'Cancelled responses never update a closed lifecycle');
    print('Connection monitor: authenticated HTTP, deltas, failure, reconnect, redirect refusal and cancellation passed');
} finally {
    monitor.close();
    server.disconnect();
}

// Enrichment is tested with a fake provider, so no destination data leaves the
// test machine and location/DNS failure states remain deterministic.
settings.set_boolean('geolocation-enabled', true);
const enrich = new ConnectionMonitor(settings, () => {});
const fixture = (host, ip, id = host) => new Map([[id, {id, host, ip, port: '443',
    kind: 'destination', name: 'firefox', network: 'TCP', route: 'proxy', rx: 0, tx: 0}]]);
const calls = [];
enrich._json = async (_session, url) => {
    calls.push(url);
    return {success: true, country: 'Test country', country_code: 'TC', latitude: 10, longitude: 20};
};
try {
    enrich.traffic.sample('proxy', fixture('remote.example', ''), 1);
    settings.set_boolean('resolve-domains', true);
    enrich._dns.set('remote.example', {at: GLib.get_monotonic_time() / 1e6, ips: ['1.1.1.1']});
    enrich._locations.set('1.1.1.1', {geo: {country: 'Test country', latitude: 10, longitude: 20}, at: 0});
    let target = enrich.snapshot().targets[0];
    check(target.endpoints[0].estimated && target.endpoints[0].geo.country === 'Test country',
        'Unreported proxy IPs can be enriched only as explicit DNS estimates');
    settings.set_boolean('resolve-domains', false);
    check(!enrich.snapshot().targets[0].endpoints.length, 'Disabling DNS hides estimated IPs');
    enrich.traffic.sample('proxy', fixture('private.example', '192.168.1.2'), 2);
    enrich.setVisible(true, false);
    await sleep(10);
    check(calls.length === 0, 'Private IPs never reach the location provider');
    enrich.traffic.sample('proxy', fixture('public.example', '8.8.8.8'), 3);
    enrich.setVisible(true, false);
    await sleep(10);
    check(calls.length === 1 && calls[0].includes('/8.8.8.8?') && !calls[0].includes('public.example'),
        'Location requests contain public IPs, never target domains');
    enrich._nextGeo = 0;
    enrich.setVisible(true, false);
    await sleep(10);
    check(calls.length === 1, 'Successful location results are cached');
    settings.set_boolean('geolocation-enabled', false);
    target = enrich.snapshot().targets.find(t => t.host === 'public.example');
    check(!target.endpoints[0].geo && target.country === 'Location lookups off', 'Disabling locations removes map markers');
    print('Connection enrichment: DNS estimates, lookup switches, local IP exclusion, public IP privacy and caching passed');
} finally { enrich.close(); }
