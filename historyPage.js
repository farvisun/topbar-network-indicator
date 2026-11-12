import Adw from 'gi://Adw';
import Gdk from 'gi://Gdk?version=4.0';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=4.0';
import {HistoryStore, RETENTION_DAYS, queryRows, exportCsv, replaceText, calendarRange} from './history.js';
import {areaScale, drawAreaChart, pointAtX} from './chart.js';
import {formatValue} from './network.js';

function label(text = '', extra = {}) {
    return new Gtk.Label({label: text, xalign: 0, ...extra});
}

const CSS = `
.tn-swatch { min-width: 10px; min-height: 10px; border-radius: 3px; }
.tn-swatch-upload { background-color: #faa647; }
.tn-swatch-download { background-color: #61b0fa; }
.tn-stat { padding: 14px 16px; }
.tn-stat-label { font-size: 0.82em; font-weight: 700; }
.tn-stat-value { font-size: 1.55em; font-weight: 800; font-feature-settings: "tnum"; }
.tn-chart-card { padding: 16px; }
.tn-numeric { font-feature-settings: "tnum"; }
.tn-readout { padding: 8px 12px; border-radius: 8px; background-color: alpha(currentColor, 0.06); }
.tn-upload { color: #e08a1e; font-weight: 700; }
.tn-download { color: #2f8ae8; font-weight: 700; }
`;

function swatch(direction) {
    const box = new Gtk.Box({valign: Gtk.Align.CENTER});
    box.add_css_class('tn-swatch');
    box.add_css_class(`tn-swatch-${direction}`);
    return box;
}

function statCard(title, direction = null) {
    const card = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL, spacing: 4, hexpand: true});
    card.add_css_class('card');
    card.add_css_class('tn-stat');
    const heading = new Gtk.Box({spacing: 6});
    if (direction) heading.append(swatch(direction));
    const caption = label(title);
    caption.add_css_class('tn-stat-label');
    caption.add_css_class('dim-label');
    heading.append(caption);
    card.append(heading);
    const value = label('—');
    value.add_css_class('tn-stat-value');
    card.append(value);
    return {card, value};
}

function dateButton(title, changed) {
    const calendar = new Gtk.Calendar();
    const popover = new Gtk.Popover({child: calendar});
    const button = new Gtk.MenuButton({label: title, popover});
    calendar.connect('day-selected', () => {
        const date = calendar.get_date();
        button.label = date.format('%Y-%m-%d');
        changed(new Date(date.get_year(), date.get_month() - 1, date.get_day_of_month()));
        popover.popdown();
    });
    return {button, calendar};
}

export class HistoryPage {
    constructor(window, settings, {root} = {}) {
        this.window = window;
        this.settings = settings;
        this._closed = false;
        this._request = 0;
        this._selection = -1;
        this._anchor = new Date();
        this._customStart = new Date();
        this._customEnd = new Date();
        this.store = new HistoryStore({
            root,
            generation: () => settings.get_string('history-generation'),
            retention: () => settings.get_int('history-retention'),
        });
        this.page = new Adw.PreferencesPage({name: 'history', title: 'History', icon_name: 'document-open-recent-symbolic'});
        this._buildChart();
        this._buildStorage();
        this._settingsId = settings.connect('changed', (_settings, key) => {
            if (key === 'history-generation' || key === 'history-retention') {
                this._data = null;
                this._rows = [];
                this._render();
                if (key === 'history-retention')
                    this.store.prune().then(() => { if (!this._closed) this.refresh(); });
                this.refresh();
            } else if (key === 'show-bits') {
                this._render();
            }
        });
        this._refreshTimer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 30, () => {
            if (window.visible_page === this.page)
                this.refresh();
            return GLib.SOURCE_CONTINUE;
        });
        window.connect('close-request', () => {
            this.close();
            return false;
        });
        this.refresh();
    }

    _buildChart() {
        this._css = new Gtk.CssProvider();
        this._css.load_from_string(CSS);
        Gtk.StyleContext.add_provider_for_display(Gdk.Display.get_default(), this._css,
            Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION);

        const reload = new Gtk.Button({icon_name: 'view-refresh-symbolic', tooltip_text: 'Refresh saved history',
            valign: Gtk.Align.CENTER});
        reload.add_css_class('flat');
        reload.connect('clicked', () => this.refresh());
        this._export = new Gtk.Button({valign: Gtk.Align.CENTER, tooltip_text: 'Export the selected period as CSV',
            child: new Adw.ButtonContent({icon_name: 'document-save-symbolic', label: 'Export CSV'})});
        this._export.add_css_class('flat');
        this._export.connect('clicked', () => this._exportCsv());
        const actions = new Gtk.Box({spacing: 4});
        actions.append(reload);
        actions.append(this._export);
        const group = new Adw.PreferencesGroup({title: 'Network Usage',
            description: 'Traffic observed while the extension is enabled, saved at one-minute resolution.',
            header_suffix: actions});
        const box = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL, spacing: 14});

        // Period toolbar: granularity on the left, navigation on the right.
        const controls = new Gtk.Box({spacing: 12});
        this._mode = new Adw.ToggleGroup({valign: Gtk.Align.CENTER});
        for (const [name, text] of [['day', 'Day'], ['week', 'Week'], ['month', 'Month'], ['custom', 'Custom']])
            this._mode.add(new Adw.Toggle({name, label: text}));
        this._mode.active = 0;
        controls.append(this._mode);
        controls.append(new Gtk.Box({hexpand: true}));
        const navigation = new Gtk.Box({valign: Gtk.Align.CENTER});
        navigation.add_css_class('linked');
        this._previous = new Gtk.Button({icon_name: 'go-previous-symbolic', tooltip_text: 'Previous period'});
        const today = new Gtk.Button({label: 'Today'});
        this._next = new Gtk.Button({icon_name: 'go-next-symbolic', tooltip_text: 'Next period'});
        navigation.append(this._previous);
        navigation.append(today);
        navigation.append(this._next);
        controls.append(navigation);
        box.append(controls);

        this._custom = new Gtk.Box({spacing: 8, visible: false});
        const from = dateButton('Start date', date => { this._customStart = date; this.refresh(); });
        const to = dateButton('End date', date => { this._customEnd = date; this.refresh(); });
        this._custom.append(label('From'));
        this._custom.append(from.button);
        this._custom.append(label('through'));
        this._custom.append(to.button);
        box.append(this._custom);
        this._mode.connect('notify::active', () => {
            const custom = this._mode.active === 3;
            this._custom.visible = custom;
            navigation.sensitive = !custom;
            this.refresh();
        });
        const navigate = direction => {
            const mode = ['day', 'week', 'month'][this._mode.active];
            this._anchor = new Date(calendarRange(this._anchor, mode, direction).start * 1000);
            this.refresh();
        };
        this._previous.connect('clicked', () => navigate(-1));
        this._next.connect('clicked', () => navigate(1));
        today.connect('clicked', () => { this._anchor = new Date(); this._mode.active = 0; this.refresh(); });

        this._period = label('', {wrap: true});
        this._period.add_css_class('title-3');
        box.append(this._period);

        const stats = new Gtk.Box({spacing: 12, homogeneous: true});
        const uploaded = statCard('Uploaded', 'upload');
        const downloaded = statCard('Downloaded', 'download');
        const total = statCard('Total');
        this._uploadedValue = uploaded.value;
        this._downloadedValue = downloaded.value;
        this._totalValue = total.value;
        stats.append(uploaded.card);
        stats.append(downloaded.card);
        stats.append(total.card);
        box.append(stats);

        const card = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL, spacing: 10});
        card.add_css_class('card');
        card.add_css_class('tn-chart-card');
        const legend = new Gtk.Box({spacing: 16});
        for (const [text, direction] of [['Upload', 'upload'], ['Download', 'download']]) {
            const item = new Gtk.Box({spacing: 6});
            item.append(swatch(direction));
            const name = label(text);
            name.add_css_class('caption');
            item.append(name);
            legend.append(item);
        }
        this._scale = label('', {hexpand: true, xalign: 1});
        this._scale.add_css_class('caption');
        this._scale.add_css_class('dim-label');
        this._scale.add_css_class('tn-numeric');
        legend.append(this._scale);
        card.append(legend);
        this._chart = new Gtk.DrawingArea({content_width: 420, content_height: 240,
            hexpand: true, focusable: true, tooltip_text: 'Upload above, download below. Use ← → to inspect.'});
        this._chart.set_direction(Gtk.TextDirection.LTR);
        this._chart.set_draw_func((_area, cr, width, height) =>
            drawAreaChart(cr, width, height, this._data?.points ?? [], this._selection));
        const motion = new Gtk.EventControllerMotion();
        motion.connect('motion', (_controller, x) => {
            if (this._data) {
                this._selection = pointAtX(x, this._chart.get_width(), this._data.points.length);
                this._renderDetail();
            }
        });
        motion.connect('leave', () => { this._selection = -1; this._renderDetail(); });
        this._chart.add_controller(motion);
        const keys = new Gtk.EventControllerKey();
        keys.connect('key-pressed', (_controller, key) => {
            if (![Gdk.KEY_Left, Gdk.KEY_Right, Gdk.KEY_Home, Gdk.KEY_End].includes(key) || !this._data)
                return false;
            const count = this._data.points.length;
            this._selection = key === Gdk.KEY_Home ? 0 : key === Gdk.KEY_End ? count - 1
                : Math.max(0, Math.min(count - 1, this._selection + (key === Gdk.KEY_Left ? -1 : 1)));
            this._renderDetail();
            return true;
        });
        this._chart.add_controller(keys);
        card.append(this._chart);
        const axis = new Gtk.Box();
        axis.set_direction(Gtk.TextDirection.LTR);
        this._axisStart = label('', {hexpand: true});
        this._axisEnd = label('', {xalign: 1});
        for (const item of [this._axisStart, this._axisEnd]) {
            item.add_css_class('caption');
            item.add_css_class('dim-label');
            item.add_css_class('tn-numeric');
            axis.append(item);
        }
        card.append(axis);

        const readout = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL, spacing: 2});
        readout.add_css_class('tn-readout');
        const readoutLine = new Gtk.Box({spacing: 16});
        this._detail = label('', {wrap: true, selectable: true, hexpand: true});
        this._detail.add_css_class('tn-numeric');
        this._detailUpload = label();
        this._detailUpload.add_css_class('tn-upload');
        this._detailUpload.add_css_class('tn-numeric');
        this._detailDownload = label();
        this._detailDownload.add_css_class('tn-download');
        this._detailDownload.add_css_class('tn-numeric');
        readoutLine.append(this._detail);
        readoutLine.append(this._detailUpload);
        readoutLine.append(this._detailDownload);
        readout.append(readoutLine);
        this._detailMeta = label('', {wrap: true, selectable: true});
        this._detailMeta.add_css_class('caption');
        this._detailMeta.add_css_class('dim-label');
        readout.append(this._detailMeta);
        card.append(readout);
        box.append(card);

        this._status = label('', {wrap: true});
        this._status.add_css_class('caption');
        this._status.add_css_class('dim-label');
        box.append(this._status);
        group.add(box);
        this.page.add(group);
    }

    _buildStorage() {
        const group = new Adw.PreferencesGroup({title: 'Saved History',
            description: 'Stored locally on this computer. Session reset does not erase history. Weeks start on Monday.'});
        const retention = new Adw.ComboRow({title: 'Keep history for',
            model: Gtk.StringList.new(['7 days', '30 days', '90 days', '1 year'])});
        retention.selected = Math.max(0, RETENTION_DAYS.indexOf(this.settings.get_int('history-retention')));
        retention.connect('notify::selected', () => this.settings.set_int('history-retention', RETENTION_DAYS[retention.selected]));
        group.add(retention);
        const clear = new Adw.ActionRow({title: 'Clear saved history', subtitle: 'Permanently delete all saved network usage'});
        const button = new Gtk.Button({label: 'Clear…', valign: Gtk.Align.CENTER});
        button.add_css_class('destructive-action');
        button.connect('clicked', () => this._confirmClear());
        clear.add_suffix(button);
        group.add(clear);
        this.page.add(group);
    }

    _range() {
        if (this._mode.active === 3) {
            return {start: calendarRange(this._customStart, 'day').start,
                end: calendarRange(this._customEnd, 'day').end};
        }
        return calendarRange(this._anchor, ['day', 'week', 'month'][this._mode.active]);
    }

    async refresh() {
        if (this._closed)
            return;
        const request = ++this._request;
        const {start, end} = this._range();
        this._export.sensitive = false;
        if (end <= start) {
            this._data = null;
            this._rows = [];
            this._status.label = 'Choose an end date on or after the start date.';
            this._render();
            return;
        }
        this._status.label = 'Loading saved history…';
        try {
            const generation = this.settings.get_string('history-generation');
            const {rows, warning} = await this.store.readRange(start, end);
            if (this._closed || request !== this._request || generation !== this.settings.get_string('history-generation'))
                return;
            this._rows = rows;
            // Minute detail for day views; coarser buckets for longer periods.
            const count = Math.min(240, Math.max(1, Math.ceil((end - start) / 60)));
            this._data = queryRows(rows, start, end, count);
            this._selection = -1;
            this._status.label = warning || (rows.length ? 'Refreshes every 30 seconds. The latest minute may still be saving.'
                : 'No saved observations in this period. Collection runs while the extension is enabled.');
            this._export.sensitive = rows.length > 0;
            this._render();
        } catch {
            if (!this._closed && request === this._request) {
                this._data = null;
                this._rows = [];
                this._status.label = 'History could not be loaded. Try refreshing.';
                this._render();
            }
        }
    }

    _render() {
        const data = this._data;
        const {start, end} = this._range();
        const bits = this.settings.get_boolean('show-bits');
        const date = time => new Date(time * 1000).toLocaleDateString(undefined,
            {weekday: 'short', year: 'numeric', month: 'short', day: 'numeric'});
        this._period.label = end - start <= 86400 + 3600 ? date(start) : `${date(start)} – ${date(end - 1)}`;
        const amount = value => data ? formatValue(value, false, false) : '—';
        this._uploadedValue.label = amount(data?.tx);
        this._downloadedValue.label = amount(data?.rx);
        this._totalValue.label = amount((data?.tx ?? 0) + (data?.rx ?? 0));
        this._summary = data ? `Uploaded ${amount(data.tx)}, downloaded ${amount(data.rx)}` : '';
        this._scale.label = data ? `Scale ±${formatValue(areaScale(data.points), bits)} per direction` : '';
        const axis = time => new Date(time * 1000).toLocaleString(undefined,
            {month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit'});
        this._axisStart.label = axis(start);
        this._axisEnd.label = axis(end);
        this._renderDetail();
    }

    _renderDetail() {
        const point = this._data?.points[this._selection];
        const bits = this.settings.get_boolean('show-bits');
        const observed = point?.duration > 0;
        this._detail.label = point
            ? `${new Date(point.time * 1000).toLocaleString()} – ${new Date(point.end * 1000).toLocaleTimeString()}`
            : 'Hover over the chart, or focus it and use ← → to inspect.';
        this._detail.opacity = point ? 1 : 0.6;
        this._detailUpload.label = observed ? `↑ ${formatValue(point.tx, bits)}` : '';
        this._detailDownload.label = observed ? `↓ ${formatValue(point.rx, bits)}` : '';
        this._detailUpload.visible = this._detailDownload.visible = observed;
        this._detailMeta.label = !point ? 'Average rates and the active interface for each interval.'
            : observed ? `${Math.round(point.duration)} s observed · ${point.configs.join('; ')}`
            : 'No observations in this interval';
        this._chart.update_property([Gtk.AccessibleProperty.LABEL],
            [`Network history. ${this._summary ?? ''}. ${this._detail.label} ${this._detailUpload.label} ${this._detailDownload.label}. ${this._detailMeta.label}`]);
        this._chart.queue_draw();
    }

    _exportCsv() {
        if (!this._data || !this._rows?.length)
            return;
        // Capture the selected data; changing dates while the chooser is open
        // must not export a different period or restore data after a clear.
        const generation = this.settings.get_string('history-generation');
        const csv = exportCsv(this._rows, this._data.start, this._data.end);
        const dialog = new Gtk.FileDialog({title: 'Export network history',
            initial_name: `network-history-${new Date(this._data.start * 1000).toISOString().slice(0, 10)}.csv`});
        dialog.save(this.window, null, async (source, result) => {
            try {
                const file = source.save_finish(result);
                if (generation !== this.settings.get_string('history-generation') || this._closed)
                    return;
                await replaceText(file, csv);
                if (!this._closed) this._status.label = 'CSV exported.';
            } catch (error) {
                if (!this._closed && !error.matches?.(Gtk.DialogError, Gtk.DialogError.DISMISSED))
                    this._status.label = 'CSV export failed. Choose a writable location and try again.';
            }
        });
    }

    _confirmClear() {
        const dialog = new Adw.AlertDialog({heading: 'Clear all saved history?',
            body: 'This permanently deletes saved network usage. New observations will continue to be collected. Session totals and app rankings are kept.',
            close_response: 'cancel', default_response: 'cancel'});
        dialog.add_response('cancel', 'Cancel');
        dialog.add_response('clear', 'Clear history');
        dialog.set_response_appearance('clear', Adw.ResponseAppearance.DESTRUCTIVE);
        dialog.connect('response', async (_dialog, response) => {
            if (response !== 'clear' || this._closed)
                return;
            this.settings.set_string('history-generation', GLib.uuid_string_random());
            this._selection = -1;
            await this.store.prune();
            if (!this._closed) {
                await this.refresh();
                if (this.store.status) this._status.label = this.store.status;
            }
        });
        dialog.present(this.window);
    }

    close() {
        if (this._closed)
            return;
        this._closed = true;
        this._request++;
        GLib.Source.remove(this._refreshTimer);
        this.settings.disconnect(this._settingsId);
        this._chart.set_draw_func(null);
        Gtk.StyleContext.remove_provider_for_display(Gdk.Display.get_default(), this._css);
    }
}
