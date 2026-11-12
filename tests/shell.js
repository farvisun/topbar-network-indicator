import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as Scripting from 'resource:///org/gnome/shell/ui/scripting.js';
import {parseProxyConnections} from '../connections.js';

export const METRICS = {};

let startupWatchdog;
export function init() {
    startupWatchdog = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 30, () => {
        console.error('Test compositor did not complete startup within 30 seconds');
        Meta.exit(Meta.ExitCode.ERROR);
        return GLib.SOURCE_REMOVE;
    });
}

export async function run() {
    GLib.Source.remove(startupWatchdog);
    await Scripting.sleep(2000);
    const uuid = 'topbar-network@farvisun.mindio';
    const extension = Main.extensionManager.lookup(uuid)?.stateObj;
    if (!extension || !Main.panel.statusArea[uuid])
        throw new Error('Network indicator did not load');
    if (extension._readFailed)
        throw new Error('Could not sample network counters');
    const labels = extension._uploadLabel.get_parent().get_children();
    if (labels[0] !== extension._uploadLabel || labels[1] !== extension._downloadLabel)
        throw new Error('Upload must appear above download');
    if (!extension._panelChart.is_mapped() || extension._panelChart.width < 60 || extension._panelChart.height < 20)
        throw new Error('Panel chart must be visible with the dropdown closed');
    extension._indicator.menu.open();
    await Scripting.sleep(300);
    if (!extension._chart.is_mapped() || extension._history.length === 0)
        throw new Error('Chart must be visible and contain samples');
    if (!extension._appsBox.is_mapped())
        throw new Error('App traffic section must be visible in the dropdown');
    for (const index of [1, 2, 3, 0]) {
        extension._rangeButtons[index].emit('clicked', 0);
        await extension._loadChartHistory();
        if (!extension._chartData || extension._chartRange !== index)
            throw new Error('Dropdown range did not load');
    }
    extension._chart.grab_key_focus();
    extension._chartSelection = 0;
    extension._renderChart();
    if (!extension._chartDetail.text.length)
        throw new Error('Chart inspection is empty');
    // Exercise the real details window with deterministic proxy data. Keep
    // provider lookups paused so this check never depends on external services.
    const monitor = extension._connections;
    extension._settings.set_boolean('resolve-domains', false);
    monitor._nextGeo = Infinity;
    const fixture = bytes => parseProxyConnections({connections: [
        {id: 'test-a', download: bytes, upload: 200,
            metadata: {host: 'example.com', destinationIP: '1.1.1.1', destinationPort: '443',
                processPath: '/usr/bin/firefox', network: 'tcp'}, chains: ['Test proxy']},
        {id: 'test-b', download: bytes / 2, upload: 100,
            metadata: {host: 'second.example', destinationIP: '8.8.8.8', network: 'udp'}, chains: ['DIRECT']},
    ]});
    monitor.traffic.sample('fixture', fixture(0), 1);
    monitor.traffic.sample('fixture', fixture(2000000), 3);
    for (const [ip, country, longitude, latitude] of [
        ['1.1.1.1', 'Australia', 151, -33], ['8.8.8.8', 'United States', -122, 37],
    ]) monitor._locations.set(ip, {geo: {country, longitude, latitude}, at: 0});
    monitor.origin = {country: 'Netherlands', longitude: 5, latitude: 52};
    extension._renderApps();
    extension._activityButtons.get('apps').emit('clicked', 0);
    if (extension._activityTab !== 'apps') throw new Error('App tab did not activate');
    extension._activityButtons.get('domains').emit('clicked', 0);
    const menuScreenshot = GLib.getenv('TOPBAR_NETWORK_MENU_SCREENSHOT');
    if (menuScreenshot) {
        // Documentation screenshots use synthetic traffic, never real usage.
        GLib.Source.remove(extension._timer);
        extension._timer = null;
        const base = GLib.get_monotonic_time() / 1_000_000;
        extension._history = Array.from({length: 61}, (_, i) => {
            const t = i / 60;
            const burst = Math.exp(-(((t - 0.72) / 0.09) ** 2));
            return {time: base - 60 + i, gap: false,
                rx: 180000 + 120000 * Math.sin(t * 9) + 1400000 * burst,
                tx: 40000 + 22000 * Math.cos(t * 7) + 160000 * burst};
        });
        extension._rates = {rx: extension._history.at(-1).rx, tx: extension._history.at(-1).tx};
        extension._totals = {rx: 2.31e9, tx: 4.8e8};
        monitor.proxyConnected = true;
        const extra = bytes => parseProxyConnections({connections: [
            {id: 'doc-a', download: bytes * 1.6, upload: bytes / 8, chains: ['Proxy'],
                metadata: {host: 'cdn.example.net', destinationIP: '93.184.216.34', destinationPort: '443',
                    processPath: '/usr/bin/firefox', network: 'tcp'}},
            {id: 'doc-b', download: bytes * 0.5, upload: bytes / 5, chains: ['DIRECT'],
                metadata: {host: 'api.example.org', destinationIP: '151.101.1.69', destinationPort: '443',
                    processPath: '/usr/bin/code', network: 'tcp'}},
            {id: 'doc-c', download: bytes * 0.2, upload: bytes / 20, chains: ['DIRECT'],
                metadata: {host: 'updates.example.org', destinationIP: '104.16.0.1', destinationPort: '443',
                    processPath: '/usr/bin/apt', network: 'tcp'}},
        ]});
        monitor.traffic.sample('doc', extra(0), 1);
        monitor.traffic.sample('doc', extra(2000000), 3);
        for (const [ip, country, longitude, latitude] of [
            ['93.184.216.34', 'United States', -77, 39], ['151.101.1.69', 'Germany', 13, 52],
            ['104.16.0.1', 'Singapore', 104, 1],
        ]) monitor._locations.set(ip, {geo: {country, longitude, latitude}, at: 0});
        monitor.origin = {country: 'Netherlands', longitude: 5, latitude: 52};
        // Only synthetic destinations may appear in documentation images.
        const realSnapshot = monitor.snapshot.bind(monitor);
        monitor.snapshot = limit => {
            const data = realSnapshot(limit);
            data.targets = data.targets.filter(t => /example/.test(t.host));
            data.status = '';
            data.proxyConnected = true;
            return data;
        };
        extension._renderApps();
        // A selected point freezes the chart, so render live data first.
        extension._chartSelection = -1;
        extension._chartData = null;
        extension._render();
        extension._selectChart(44);
        await Scripting.sleep(300);
        const stream = Gio.File.new_for_path(menuScreenshot).replace(null, false, Gio.FileCreateFlags.PRIVATE, null);
        await new Shell.Screenshot().screenshot(false, stream);
        stream.close(null);
    }
    extension._openConnections();
    await Scripting.sleep(400);
    const details = extension._connectionDialog;
    if (!details || !details._map.is_mapped() || details._map.width < 300)
        throw new Error('World map did not open');
    details._search.set_text('example.com');
    details.update();
    if (details._visibleTargets.length !== 1 || !details._detail.text.includes('1.1.1.1') ||
        !details._detail.text.includes('Australia') || !details._detail.text.includes('firefox'))
        throw new Error('Destination search or selected target details failed');
    if (!details._legend.text.includes('1 of 1')) throw new Error('Map did not locate the selected destination');
    const screenshotPath = GLib.getenv('TOPBAR_NETWORK_SCREENSHOT');
    if (screenshotPath) {
        details._search.set_text('example');
        details.update();
        await Scripting.sleep(300);
        const stream = Gio.File.new_for_path(screenshotPath).replace(null, false, Gio.FileCreateFlags.PRIVATE, null);
        await new Shell.Screenshot().screenshot(false, stream);
        stream.close(null);
        details._search.set_text('example.com');
        details.update();
    }
    if (details.contentLayout.get_transformed_position()[1] < 0 ||
        details._detailScroll.get_transformed_position()[1] + details._detailScroll.height > global.stage.height)
        throw new Error('Connection dialog does not fit on screen');
    const row = [...details._rows.values()][0];
    if (row.country.get_transformed_position()[0] < details._map.get_transformed_position()[0] + 400)
        throw new Error('Destination table columns are not aligned');
    const longHost = 'verylongsubdomain.'.repeat(13) + 'example.com';
    monitor.traffic.sample('long-fixture', parseProxyConnections({connections: [{
        id: 'test-long', download: 0, upload: 0,
        metadata: {host: longHost, destinationIP: '8.8.8.8', processPath: '/usr/bin/firefox'},
        chains: Array(12).fill('a long proxy route label '.repeat(4)),
    }]}), 3);
    details._search.set_text('verylongsubdomain');
    await Scripting.sleep(50);
    if (details._detailScroll.get_transformed_position()[1] + details._detailScroll.height > global.stage.height ||
        [...details._rows.values()][0].button.width > details.contentLayout.width + 1)
        throw new Error('Long domains or routes overflow the connection window');
    details._search.set_text('no match exists');
    if (!details._empty.visible || details._rows.size) throw new Error('Empty search is not handled');
    details._search.set_text('');
    details.close();
    await Scripting.sleep(300);
    if (extension._connectionDialog) throw new Error('Closed dialog was retained');
    const now = Math.floor(Date.now() / 1000) - 10;
    extension._store.add(now, now + 5, 1234, 567, 'Lifecycle test');
    await extension._store.flush();
    const before = await extension._store.readRange(now, now + 60);
    if (!before.rows.some(row => row.config === 'Lifecycle test'))
        throw new Error('History write failed');
    extension._indicator.menu.close();
    const settings = extension._settings;
    for (const position of [0, 1, 2]) {
        settings.set_int('position', position);
        await Scripting.sleep(100);
        if (!Main.panel.statusArea[uuid])
            throw new Error('Indicator lost while changing position');
    }
    settings.set_boolean('show-bits', true);
    settings.set_int('refresh-interval', 2);
    await Scripting.sleep(2500);
    extension.disable();
    if (extension._historyTimer || extension._store || extension._timer || extension._chart || extension._panelChart || extension._appProcess || extension._appTimeout || extension._connections || extension._connectionDialog || Main.panel.statusArea[uuid])
        throw new Error('Indicator or timer survived disable');
    extension.enable();
    await Scripting.sleep(100);
    if (!Main.panel.statusArea[uuid])
        throw new Error('Indicator failed to re-enable');
    const after = await extension._store.readRange(now, now + 60);
    if (after.rows.filter(row => row.config === 'Lifecycle test').reduce((sum, row) => sum + row.rx, 0) !== 1234)
        throw new Error('History did not survive re-enable');
    settings.set_string('history-generation', GLib.uuid_string_random());
    await extension._store.prune();
    if ((await extension._store.readRange(now, now + 60)).rows.some(row => row.config === 'Lifecycle test'))
        throw new Error('Cleared history reappeared');
    extension._openConnections();
    await Scripting.sleep(200);
    extension.disable();
    if (extension._connectionDialog || extension._connections) throw new Error('Open map survived disable');
    extension.enable();
    print('GNOME charts, destination tabs, world map, search, details, history and lifecycle checks passed');
}
