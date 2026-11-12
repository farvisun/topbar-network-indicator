import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Pango from 'gi://Pango';
import St from 'gi://St';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {parseCounters, deltaCounters, formatValue, formatPanelValue} from './network.js';
import {addSample, drawChart, liveChartData, areaScale, drawAreaChart, pointAtX} from './chart.js';
import {HistoryStore, queryRows, DAY} from './history.js';
import {AppTraffic, parseAppSockets} from './apps.js';
import {ConnectionMonitor} from './connectionMonitor.js';
import {ConnectionDialog} from './connectionDialog.js';

const METER_WIDTH = 360;
// Secondary text is dimmed with opacity rather than a fixed grey so it keeps
// readable contrast against both the light and dark Shell menu styles.
const DIM = 160;

function dim(actor) {
    actor.opacity = DIM;
    return actor;
}

function setChecked(button, checked) {
    if (checked) button.add_style_pseudo_class('checked');
    else button.remove_style_pseudo_class('checked');
    button.opacity = checked ? 255 : 200;
}

function readText(path) {
    const [ok, contents] = Gio.File.new_for_path(path).load_contents(null);
    if (!ok)
        throw new Error(`Could not read ${path}`);
    return new TextDecoder().decode(contents);
}

export default class TopbarNetwork extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._appTraffic = new AppTraffic();
        this._appError = null;
        this._activityTab = 'domains';
        this._connections = new ConnectionMonitor(this._settings, () => {
            if (this._appsBox) this._renderApps();
            this._connectionDialog?.update();
        });
        this._previous = new Map();
        this._lastTime = 0;
        this._totals = {rx: 0, tx: 0};
        this._history = [];
        this._rates = {rx: 0, tx: 0};
        this._lastWall = 0;
        this._chartRange = 0;
        this._chartSelection = -1;
        this._chartRequest = 0;
        this._savedChartData = null;
        const settings = this._settings;
        const store = new HistoryStore({
            generation: () => settings.get_string('history-generation'),
            retention: () => settings.get_int('history-retention'),
            onStatus: () => { if (this._store === store) this._renderChart(); },
        });
        this._store = store;
        this._createIndicator();
        store.prune();
        let pruneDay = Math.floor(Date.now() / 1000 / DAY);
        this._historyTimer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 60, () => {
            store.flush().then(() => { if (this._store === store) this._loadChartHistory(); });
            const day = Math.floor(Date.now() / 1000 / DAY);
            if (day !== pruneDay) {
                pruneDay = day;
                store.prune();
            }
            return GLib.SOURCE_CONTINUE;
        });
        this._settingsId = this._settings.connect('changed', (_settings, key) => {
            if (key === 'position')
                this._createIndicator();
            if (['proxy-controller', 'controller-secret-generation', 'geolocation-enabled', 'resolve-domains'].includes(key)) {
                this._connections.configure();
                this._connections.poll();
            }
            if (key === 'interface' || key === 'refresh-interval') {
                this._lastTime = 0;
                this._previous = new Map();
                this._history = [];
                this._restartTimer();
            }
            if (key === 'history-generation') {
                // Clear the baseline too, so pre-clear bytes cannot leak into new history.
                this._lastTime = 0;
                this._history = [];
                this._savedChartData = null;
                this._store.prune().then(() => this._loadChartHistory());
            }
            if (key === 'history-retention') {
                this._store.prune().then(() => this._loadChartHistory());
            }
            this._render();
            this._connectionDialog?.update();
        });
        this._sample();
        this._restartTimer();
    }

    _createIndicator() {
        this._indicator?.destroy();
        this._indicator = new PanelMenu.Button(0.0, 'Network speed');
        this._indicator.add_style_class_name('topbar-network-indicator');
        const indicator = this._indicator;
        // The Shell can destroy the panel at shutdown without disabling us;
        // late async callbacks must then stop touching disposed actors.
        indicator.connect('destroy', () => {
            if (this._indicator !== indicator) return;
            this._indicator = null;
            this._chart = null;
            this._activityList = null;
        });
        const speeds = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            y_align: Clutter.ActorAlign.CENTER,
            style_class: 'topbar-network-speeds',
        });
        this._uploadLabel = new St.Label({
            text: '↑   —     ',
            style_class: 'topbar-network-label',
        });
        this._downloadLabel = new St.Label({
            text: '↓   —     ',
            style_class: 'topbar-network-label',
        });
        // Keep download/upload order readable on Persian and other RTL desktops.
        for (const label of [this._uploadLabel, this._downloadLabel]) {
            label.set_text_direction(Clutter.TextDirection.LTR);
            speeds.add_child(label);
        }
        // Explicit columns keep the plot on the right regardless of desktop direction.
        const panelLayout = new Clutter.GridLayout({column_spacing: 3});
        const panelBox = new St.Widget({
            layout_manager: panelLayout,
            y_align: Clutter.ActorAlign.CENTER,
        });
        panelBox.set_text_direction(Clutter.TextDirection.LTR);
        this._panelChart = this._newChart(true);
        panelLayout.attach(this._panelChart, 1, 0, 1, 1);
        panelLayout.attach(speeds, 0, 0, 1, 1);
        this._indicator.add_child(panelBox);
        this._indicator.menu.box.add_style_class_name('topbar-network-menu');
        this._createSummary();
        this._createChart();
        this._createApps();
        this._indicator.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this._indicator.menu.addAction('Connection details & world map…',
            () => this._openConnections(), 'mark-location-symbolic');
        this._indicator.menu.addAction('Usage history…',
            () => this._openPreferences('history'), 'document-open-recent-symbolic');
        this._indicator.menu.addAction('Settings…',
            () => this._openPreferences('network'), 'emblem-system-symbolic');
        this._indicator.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this._indicator.menu.addAction('Reset session totals', () => {
            this._stopAppSample();
            this._appTraffic.reset();
            this._connections.reset();
            this._totals = {rx: 0, tx: 0};
            this._previous = new Map();
            this._lastTime = 0;
            this._sample();
        }, 'edit-clear-history-symbolic');
        const position = ['left', 'center', 'right'][this._settings.get_int('position')];
        Main.panel.addToStatusArea(this.uuid, this._indicator, 0, position);
    }

    _openPreferences(page) {
        this._settings.set_string('preferences-page', page);
        this.openPreferences();
    }

    _menuSection(styleClass) {
        const row = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false,
            style_class: 'topbar-network-section'});
        const box = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL,
            style_class: styleClass, x_expand: true});
        box.set_text_direction(Clutter.TextDirection.LTR);
        row.add_child(box);
        this._indicator.menu.addMenuItem(row);
        return box;
    }

    _createSummary() {
        const box = this._menuSection('topbar-network-summary');
        const header = new St.BoxLayout({style_class: 'topbar-network-header'});
        header.add_child(new St.Label({text: 'Network', style_class: 'topbar-network-title',
            x_expand: true, y_align: Clutter.ActorAlign.CENTER}));
        const status = new St.BoxLayout({style_class: 'topbar-network-status', y_align: Clutter.ActorAlign.CENTER});
        this._statusDot = new St.Widget({style_class: 'topbar-network-status-dot', y_align: Clutter.ActorAlign.CENTER});
        this._interfaceLabel = new St.Label({text: 'Connecting…', y_align: Clutter.ActorAlign.CENTER});
        this._interfaceLabel.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        status.add_child(this._statusDot);
        status.add_child(this._interfaceLabel);
        header.add_child(status);
        box.add_child(header);
        const stats = new St.BoxLayout({style_class: 'topbar-network-stats'});
        const tile = (title, direction) => {
            const card = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL,
                style_class: `topbar-network-stat topbar-network-stat-${direction}`, x_expand: true});
            const heading = new St.BoxLayout({style_class: 'topbar-network-stat-heading'});
            heading.add_child(new St.Widget({style_class: `topbar-network-swatch topbar-network-swatch-${direction}`,
                y_align: Clutter.ActorAlign.CENTER}));
            heading.add_child(dim(new St.Label({text: title, style_class: 'topbar-network-stat-label',
                y_align: Clutter.ActorAlign.CENTER})));
            card.add_child(heading);
            const value = new St.Label({text: '—', style_class: 'topbar-network-stat-value'});
            const total = dim(new St.Label({text: '', style_class: 'topbar-network-stat-sub'}));
            card.add_child(value);
            card.add_child(total);
            stats.add_child(card);
            return [value, total];
        };
        [this._chartUpload, this._uploadTotal] = tile('Upload', 'upload');
        [this._chartDownload, this._downloadTotal] = tile('Download', 'download');
        box.add_child(stats);
    }

    _segmented(items, styleClass = 'topbar-network-segmented') {
        const group = new St.BoxLayout({style_class: styleClass, y_align: Clutter.ActorAlign.CENTER});
        const buttons = items.map(([text, accessible, clicked]) => {
            const button = new St.Button({label: text, can_focus: true,
                style_class: 'topbar-network-segment', accessible_name: accessible});
            button.connect('clicked', clicked);
            group.add_child(button);
            return button;
        });
        return {group, buttons};
    }

    _createChart() {
        const box = this._menuSection('topbar-network-card topbar-network-chart');
        const toolbar = new St.BoxLayout({style_class: 'topbar-network-card-header'});
        toolbar.add_child(new St.Label({text: 'Throughput', style_class: 'topbar-network-card-title',
            x_expand: true, y_align: Clutter.ActorAlign.CENTER}));
        const ranges = this._segmented(['Live', '1H', '24H', '7D'].map((text, index) => [text,
            `Chart range: ${['Live', '1 hour', '24 hours', '7 days'][index]}`, () => {
                this._chartRange = index;
                this._chartSelection = -1;
                this._savedChartData = null;
                this._renderChart();
                this._loadChartHistory();
            }]));
        this._rangeButtons = ranges.buttons;
        toolbar.add_child(ranges.group);
        box.add_child(toolbar);
        const legend = new St.BoxLayout({style_class: 'topbar-network-legend'});
        for (const [text, direction] of [['Upload', 'upload'], ['Download', 'download']]) {
            const item = new St.BoxLayout({style_class: 'topbar-network-legend-item'});
            item.add_child(new St.Widget({style_class: `topbar-network-swatch topbar-network-swatch-${direction}`,
                y_align: Clutter.ActorAlign.CENTER}));
            item.add_child(dim(new St.Label({text, style_class: 'topbar-network-caption', y_align: Clutter.ActorAlign.CENTER})));
            legend.add_child(item);
        }
        legend.add_child(new St.Widget({x_expand: true}));
        this._chartScaleLabel = dim(new St.Label({style_class: 'topbar-network-caption topbar-network-numeric',
            y_align: Clutter.ActorAlign.CENTER}));
        legend.add_child(this._chartScaleLabel);
        box.add_child(legend);
        this._chart = this._newChart(false);
        box.add_child(this._chart);
        const axis = new St.BoxLayout({style_class: 'topbar-network-axis'});
        this._axisStart = dim(new St.Label({style_class: 'topbar-network-caption topbar-network-numeric', x_expand: true}));
        this._axisEnd = dim(new St.Label({style_class: 'topbar-network-caption topbar-network-numeric'}));
        axis.add_child(this._axisStart);
        axis.add_child(this._axisEnd);
        box.add_child(axis);
        const readout = new St.BoxLayout({style_class: 'topbar-network-readout'});
        this._chartDetail = new St.Label({style_class: 'topbar-network-readout-time', x_expand: true,
            y_align: Clutter.ActorAlign.CENTER});
        this._chartDetail.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        this._readoutUpload = new St.Label({style_class: 'topbar-network-readout-value topbar-network-upload',
            y_align: Clutter.ActorAlign.CENTER});
        this._readoutDownload = new St.Label({style_class: 'topbar-network-readout-value topbar-network-download',
            y_align: Clutter.ActorAlign.CENTER});
        readout.add_child(this._chartDetail);
        readout.add_child(this._readoutUpload);
        readout.add_child(this._readoutDownload);
        box.add_child(readout);
        const footer = new St.BoxLayout({style_class: 'topbar-network-card-footer'});
        footer.add_child(dim(new St.Label({text: 'Range total', style_class: 'topbar-network-caption', x_expand: true})));
        this._chartTotals = new St.Label({style_class: 'topbar-network-caption topbar-network-numeric'});
        footer.add_child(this._chartTotals);
        box.add_child(footer);
        this._historyStatus = new St.Label({style_class: 'topbar-network-notice'});
        this._historyStatus.clutter_text.line_wrap = true;
        this._historyStatus.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
        box.add_child(this._historyStatus);
        this._indicator.menu.connect('open-state-changed', (_menu, open) => {
            this._connections?.setVisible(open && this._activityTab === 'domains', !!this._connectionDialog);
            if (open) {
                this._chartSelection = -1;
                this._renderChart();
                this._loadChartHistory();
            }
        });
    }

    async _loadChartHistory() {
        if (!this._store || !this._indicator?.menu.isOpen || !this._chartRange)
            return;
        const store = this._store;
        const request = ++this._chartRequest;
        const range = this._chartRange;
        const end = Date.now() / 1000;
        const start = end - [60, 3600, DAY, 7 * DAY][range];
        try {
            const {rows, warning} = await store.readRange(start, end);
            if (this._store !== store || request !== this._chartRequest || range !== this._chartRange)
                return;
            this._savedChartData = queryRows(rows, start, end, [60, 60, 96, 168][range]);
            this._savedChartData.warning = warning;
            this._renderChart();
        } catch {
            if (this._store === store && request === this._chartRequest) {
                this._historyStatus.text = 'History unavailable — live collection continues';
                this._historyStatus.show();
            }
        }
    }

    _renderChart() {
        if (!this._chart || !this._rates)
            return;
        const bits = this._settings.get_boolean('show-bits');
        for (const [index, button] of this._rangeButtons.entries())
            setChecked(button, index === this._chartRange);
        this._chartData = this._chartRange ? this._savedChartData : liveChartData(
            this._history, GLib.get_monotonic_time() / 1_000_000, Date.now() / 1000);
        const data = this._chartData;
        this._chartScaleLabel.text = data ? `±${formatValue(areaScale(data.points), bits)}` : '';
        const dateText = time => new Date(time * 1000).toLocaleString(undefined,
            this._chartRange >= 2 ? {month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit'}
                : {hour: '2-digit', minute: '2-digit', second: '2-digit'});
        const live = this._chartRange === 0;
        this._axisStart.text = !data ? '' : live ? '60 s ago' : dateText(data.start);
        this._axisEnd.text = !data ? '' : live ? 'Now' : dateText(data.end);
        this._chartTotals.text = data
            ? `↑ ${formatValue(data.tx, false, false)}   ↓ ${formatValue(data.rx, false, false)}` : '—';
        const point = data?.points[this._chartSelection];
        const observed = point?.duration > 0;
        this._chartDetail.text = point ? `${dateText(point.time)}${observed ? '' : ' · No observations'}`
            : !data ? 'Loading saved history…'
            : data.points.some(p => p.duration) ? 'Hover or use ← → to inspect'
            : 'No observations in this range';
        if (point) this._chartDetail.remove_style_class_name('topbar-network-hint');
        else this._chartDetail.add_style_class_name('topbar-network-hint');
        this._chartDetail.opacity = point ? 255 : DIM;
        this._readoutUpload.text = observed ? `↑ ${formatValue(point.tx, bits)}` : '';
        this._readoutDownload.text = observed ? `↓ ${formatValue(point.rx, bits)}` : '';
        this._readoutUpload.visible = this._readoutDownload.visible = observed;
        this._chart.accessible_name = `Traffic chart. ${this._chartDetail.text}${observed
            ? `: upload ${this._readoutUpload.text.slice(2)}, download ${this._readoutDownload.text.slice(2)}` : ''}. Range total ${this._chartTotals.text}`;
        this._historyStatus.text = this._store?.status || data?.warning || '';
        this._historyStatus.visible = !!this._historyStatus.text;
        if (this._indicator.menu.isOpen)
            this._chart.queue_repaint();
    }

    _newChart(compact) {
        const chart = new St.DrawingArea({
            style_class: compact ? 'topbar-network-panel-plot' : 'topbar-network-plot',
            width: compact ? 64 : 360,
            height: compact ? 24 : 160,
            reactive: !compact, can_focus: !compact, track_hover: !compact,
            y_align: Clutter.ActorAlign.CENTER,
            accessible_name: 'Traffic: upload above, download below',
        });
        chart.connect('repaint', area => {
            const cr = area.get_context();
            try {
                const [width, height] = area.get_surface_size();
                if (compact) {
                    drawChart(cr, width, height, this._history,
                        GLib.get_monotonic_time() / 1_000_000, true);
                } else {
                    drawAreaChart(cr, width, height, this._chartData?.points ?? [], this._chartSelection);
                }
            } finally {
                cr.$dispose();
            }
        });
        if (!compact) {
            chart.connect('motion-event', (_actor, event) => {
                const [x, y] = event.get_coords();
                const [ok, localX] = chart.transform_stage_point(x, y);
                if (ok && this._chartData) {
                    this._chartSelection = pointAtX(localX, chart.width, this._chartData.points.length);
                    this._renderChart();
                }
                return Clutter.EVENT_PROPAGATE;
            });
            chart.connect('leave-event', () => {
                this._chartSelection = -1;
                this._renderChart();
                return Clutter.EVENT_PROPAGATE;
            });
            chart.connect('key-press-event', (_actor, event) => {
                const key = event.get_key_symbol();
                if (![Clutter.KEY_Left, Clutter.KEY_Right, Clutter.KEY_Home, Clutter.KEY_End].includes(key))
                    return Clutter.EVENT_PROPAGATE;
                const count = this._chartData?.points.length ?? 0;
                if (count) {
                    this._chartSelection = key === Clutter.KEY_Home ? 0 : key === Clutter.KEY_End ? count - 1
                        : Math.max(0, Math.min(count - 1, this._chartSelection + (key === Clutter.KEY_Left ? -1 : 1)));
                    this._renderChart();
                }
                return Clutter.EVENT_STOP;
            });
        }
        return chart;
    }

    _createApps() {
        this._appsBox = this._menuSection('topbar-network-card topbar-network-apps');
        const header = new St.BoxLayout({style_class: 'topbar-network-card-header'});
        this._activityTitle = new St.Label({style_class: 'topbar-network-card-title',
            x_expand: true, y_align: Clutter.ActorAlign.CENTER});
        header.add_child(this._activityTitle);
        const tabs = this._segmented([['domains', 'Destinations'], ['apps', 'Apps']].map(([key, title]) => [title,
            `Show top ${title.toLowerCase()}`, () => {
                this._activityTab = key;
                this._connections.setVisible(key === 'domains' && this._indicator.menu.isOpen, !!this._connectionDialog);
                this._renderApps();
            }]));
        this._activityButtons = new Map([['domains', tabs.buttons[0]], ['apps', tabs.buttons[1]]]);
        header.add_child(tabs.group);
        this._appsBox.add_child(header);
        this._activitySubtitle = dim(new St.Label({style_class: 'topbar-network-caption'}));
        this._appsBox.add_child(this._activitySubtitle);
        this._activityList = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL,
            style_class: 'topbar-network-activity-list', x_expand: true});
        this._appsBox.add_child(this._activityList);
        this._renderApps();
    }

    _activityRow(name, value, caption, ratio) {
        const box = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, style_class: 'topbar-network-list-row'});
        const heading = new St.BoxLayout({style_class: 'topbar-network-list-heading'});
        const label = new St.Label({text: name, style_class: 'topbar-network-list-name', x_expand: true});
        label.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        heading.add_child(label);
        heading.add_child(dim(new St.Label({text: value, style_class: 'topbar-network-list-value topbar-network-numeric'})));
        box.add_child(heading);
        const meta = dim(new St.Label({text: caption, style_class: 'topbar-network-caption'}));
        meta.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        box.add_child(meta);
        const track = new St.BoxLayout({style_class: 'topbar-network-meter', x_expand: true});
        track.add_child(new St.Widget({style_class: 'topbar-network-meter-fill',
            width: Math.max(4, Math.round(METER_WIDTH * ratio))}));
        box.add_child(track);
        return box;
    }

    _activityNotice(text) {
        const label = dim(new St.Label({text, style_class: 'topbar-network-empty'}));
        label.clutter_text.line_wrap = true;
        label.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
        return label;
    }

    _renderApps() {
        if (!this._activityList) return;
        for (const [key, button] of this._activityButtons)
            setChecked(button, key === this._activityTab);
        const list = this._activityList;
        list.destroy_all_children();
        if (this._activityTab === 'domains') {
            const data = this._connections.snapshot(5);
            this._activityTitle.text = 'Top destinations';
            this._activitySubtitle.text = 'Session traffic by domain and target IP';
            if (!data.proxyConnected) {
                const status = new St.Label({text: 'Proxy targets need Throne’s Clash API. Open connection details for setup.',
                    style_class: 'topbar-network-notice'});
                status.clutter_text.line_wrap = true;
                status.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
                list.add_child(status);
            }
            if (!data.targets.length) list.add_child(this._activityNotice('Waiting for destination traffic…'));
            const max = Math.max(1, ...data.targets.map(t => t.rx + t.tx));
            for (const target of data.targets) {
                list.add_child(this._activityRow(target.displayHost, formatValue(target.rx + target.tx, false, false),
                    target.kind === 'proxy-endpoint' ? 'Proxy transport endpoint' : target.country,
                    (target.rx + target.tx) / max));
            }
            return;
        }
        this._activityTitle.text = 'Top apps';
        this._activitySubtitle.text = 'TCP socket owners · proxies include forwarded traffic';
        const apps = this._appTraffic.top();
        if (this._appError || !apps.length) {
            list.add_child(this._activityNotice(this._appError ?? 'Waiting for app traffic…'));
            return;
        }
        const max = apps[0].rx + apps[0].tx;
        const bits = this._settings.get_boolean('show-bits');
        for (const app of apps) {
            list.add_child(this._activityRow(app.name, formatValue(app.rx + app.tx, false, false),
                `↑ ${formatValue(app.txRate, bits)}   ↓ ${formatValue(app.rxRate, bits)}`,
                (app.rx + app.tx) / Math.max(1, max)));
        }
    }

    _openConnections() {
        this._indicator.menu.close();
        if (this._connectionDialog) return;
        let land = null;
        try { land = JSON.parse(readText(`${this.path}/data/world-land.geojson`)); }
        catch (error) { console.error(`Topbar Network map: ${error.message}`); }
        this._connections.setVisible(false, true);
        const dialog = new ConnectionDialog({snapshot: () => this._connections.snapshot(), land,
            settings: this._settings, onSettings: () => this._openPreferences('network'),
            onClosed: () => {
                if (this._connectionDialog !== dialog) return;
                this._connectionDialog = null;
                this._connections?.setVisible(this._indicator?.menu.isOpen && this._activityTab === 'domains', false);
            }});
        this._connectionDialog = dialog;
        dialog.open();
    }

    _stopAppSample() {
        if (this._appTimeout)
            GLib.Source.remove(this._appTimeout);
        this._appTimeout = null;
        this._appCancellable?.cancel();
        this._appProcess?.force_exit();
        this._appCancellable = null;
        this._appProcess = null;
    }

    _sampleApps() {
        if (this._appProcess)
            return;
        const program = GLib.find_program_in_path('ss');
        if (!program) {
            this._connections.socketError();
            this._appError = 'Install iproute2 (ss) to show app traffic';
            this._renderApps();
            return;
        }
        try {
            const process = Gio.Subprocess.new(
                [program, '-H', '-O', '-t', '-i', '-n', '-p', '-e'],
                Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE);
            const cancellable = new Gio.Cancellable();
            this._appProcess = process;
            this._appCancellable = cancellable;
            this._appTimeout = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 3, () => {
                this._appTimeout = null;
                process.force_exit();
                return GLib.SOURCE_REMOVE;
            });
            process.communicate_utf8_async(null, cancellable, (source, result) => {
                let output;
                let failed = false;
                try {
                    output = source.communicate_utf8_finish(result);
                } catch {
                    failed = true;
                }
                // Finish even cancelled operations, but never update a later lifecycle.
                if (this._appProcess !== process)
                    return;
                if (this._appTimeout)
                    GLib.Source.remove(this._appTimeout);
                this._appTimeout = null;
                this._appProcess = null;
                this._appCancellable = null;
                try {
                    if (failed)
                        throw new Error('Socket read cancelled');
                    const [, stdout, stderr] = output;
                    if (!source.get_successful() || stderr.trim())
                        throw new Error('Socket statistics unavailable');
                    const now = GLib.get_monotonic_time() / 1_000_000;
                    this._appTraffic.sample(parseAppSockets(stdout), now);
                    this._connections.updateSockets(parseAppSockets(stdout, {includeLoopback: true}), now);
                    this._appError = null;
                } catch {
                    this._appError = 'App traffic unavailable: socket access restricted';
                    this._appTraffic.previous = null;
                    this._connections.socketError();
                }
                this._renderApps();
            });
        } catch {
            this._appError = 'Could not start ss to read app traffic';
            this._renderApps();
        }
    }

    _render() {
        if (!this._indicator) return;
        this._panelChart.queue_repaint();
        this._renderApps();
        const bits = this._settings.get_boolean('show-bits');
        const down = formatValue(this._rates.rx, bits);
        const up = formatValue(this._rates.tx, bits);
        const available = this._names?.length > 0 && !this._readFailed;
        this._uploadLabel.text = available ? `↑ ${formatPanelValue(this._rates.tx, bits)}` : '↑   —     ';
        this._downloadLabel.text = available ? `↓ ${formatPanelValue(this._rates.rx, bits)}` : '↓   —     ';
        this._indicator.accessible_name = available
            ? `Network: upload ${up}, download ${down}` : 'Network: no interface';
        const requested = this._settings.get_string('interface').trim();
        this._interfaceLabel.text = this._readFailed ? 'Statistics unavailable'
            : available ? this._names.join(', ')
            : requested ? `${requested} unavailable` : 'Offline';
        if (available) this._statusDot.remove_style_class_name('topbar-network-status-offline');
        else this._statusDot.add_style_class_name('topbar-network-status-offline');
        this._chartUpload.text = available ? up : '—';
        this._chartDownload.text = available ? down : '—';
        this._uploadTotal.text = `${formatValue(this._totals.tx, false, false)} this session`;
        this._downloadTotal.text = `${formatValue(this._totals.rx, false, false)} this session`;
        this._renderChart();
    }

    _restartTimer() {
        if (this._timer)
            GLib.Source.remove(this._timer);
        this._timer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT,
            this._settings.get_int('refresh-interval'), () => {
                this._sample();
                return GLib.SOURCE_CONTINUE;
            });
    }

    _selectInterfaces(counters) {
        const requested = this._settings.get_string('interface').trim();
        if (requested)
            return counters.has(requested) ? [requested] : [];
        const names = [...counters.keys()];
        const physical = names.filter(name =>
            Gio.File.new_for_path(`/sys/class/net/${name}/device`).query_exists(null));
        if (physical.length)
            return physical;
        // For virtual machines and systems with no physical network device,
        // use the default route instead of summing bridges and their children.
        try {
            const routes = readText('/proc/net/route').trim().split('\n').slice(1)
                .map(line => line.trim().split(/\s+/))
                .filter(fields => fields[1] === '00000000' &&
                    (parseInt(fields[3], 16) & 1) && counters.has(fields[0]))
                .sort((a, b) => Number(a[6]) - Number(b[6]));
            if (routes.length)
                return [routes[0][0]];
        } catch {
            // An explicit interface remains available for unusual setups.
        }
        try {
            const routes = readText('/proc/net/ipv6_route').trim().split('\n')
                .map(line => line.trim().split(/\s+/))
                .filter(fields => fields[0] === '0'.repeat(32) && fields[1] === '00' &&
                    (parseInt(fields[8], 16) & 1) && counters.has(fields[9]))
                .sort((a, b) => parseInt(a[5], 16) - parseInt(b[5], 16));
            if (routes.length)
                return [routes[0][9]];
        } catch {
            // No default IPv6 route.
        }
        return [];
    }

    _sample() {
        this._sampleApps();
        this._connections.poll();
        try {
            const current = parseCounters(readText('/proc/net/dev'));
            const names = this._selectInterfaces(current);
            const now = GLib.get_monotonic_time() / 1_000_000;
            const wall = Date.now() / 1000;
            const elapsed = now - this._lastTime;
            const delta = deltaCounters(this._previous, current, names);
            const hasBaseline = this._lastTime > 0 && elapsed > 0;
            if (hasBaseline) {
                this._totals.rx += delta.rx;
                this._totals.tx += delta.tx;
            }
            // Long gaps after suspend should not produce a misleading speed.
            const sameInterfaces = names.join(',') === (this._names ?? []).join(',');
            const clockStable = Math.abs((wall - this._lastWall) - elapsed) < 1;
            const countersStable = names.every(name => {
                const before = this._previous.get(name);
                const after = current.get(name);
                return before && after.rx >= before.rx && after.tx >= before.tx;
            });
            const validRate = hasBaseline && elapsed < 10 && sameInterfaces && countersStable && clockStable;
            if (validRate && names.length) {
                const requested = this._settings.get_string('interface').trim();
                const config = requested ? `Interface: ${requested}` : `Automatic: ${names.join(', ')}`;
                this._store.add(wall - elapsed, wall, delta.rx, delta.tx, config);
            }
            this._rates = {
                rx: validRate ? delta.rx / elapsed : 0,
                tx: validRate ? delta.tx / elapsed : 0,
            };
            if (hasBaseline && !validRate)
                this._history = [];
            addSample(this._history, now, this._rates.rx, this._rates.tx);
            this._history.at(-1).gap = !validRate;
            this._names = names;
            this._readFailed = false;
            this._render();
            this._previous = current;
            this._lastTime = now;
            this._lastWall = wall;
        } catch (error) {
            this._previous = new Map();
            this._lastTime = 0;
            this._rates = {rx: 0, tx: 0};
            // Report once per failure episode, not on every timer tick.
            if (!this._readFailed)
                console.error(`Topbar Network: ${error.message}`);
            this._readFailed = true;
            this._render();
            return;
        }
        this._readFailed = false;
    }

    disable() {
        const store = this._store;
        this._store = null;
        this._chartRequest++;
        // This independent store finishes its final asynchronous write after
        // Shell actors have been destroyed, without touching the next lifecycle.
        store?.flush();
        if (this._historyTimer)
            GLib.Source.remove(this._historyTimer);
        this._historyTimer = null;
        this._stopAppSample();
        this._connectionDialog?.destroy();
        this._connectionDialog = null;
        this._connections?.close();
        this._connections = null;
        if (this._timer)
            GLib.Source.remove(this._timer);
        this._timer = null;
        if (this._settingsId)
            this._settings.disconnect(this._settingsId);
        this._settingsId = null;
        this._indicator?.destroy();
        this._indicator = null;
        this._uploadLabel = null;
        this._downloadLabel = null;
        this._chart = null;
        this._panelChart = null;
        this._appsBox = null;
        this._activityList = null;
        this._activityButtons = null;
        this._appTraffic = null;
        this._chartScaleLabel = null;
        this._history = null;
        this._chartData = null;
        this._savedChartData = null;
        this._rangeButtons = null;
        this._chartUpload = null;
        this._chartDownload = null;
        this._chartDetail = null;
        this._chartTotals = null;
        this._historyStatus = null;
        this._axisStart = null;
        this._axisEnd = null;
        this._rates = null;
        this._names = null;
        this._interfaceLabel = null;
        this._statusDot = null;
        this._uploadTotal = null;
        this._downloadTotal = null;
        this._readoutUpload = null;
        this._readoutDownload = null;
        this._activityTitle = null;
        this._activitySubtitle = null;
        this._settings = null;
        this._previous = null;
        this._totals = null;
        this._lastTime = 0;
        this._readFailed = false;
    }
}
