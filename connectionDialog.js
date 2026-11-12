import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import Pango from 'gi://Pango';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as ModalDialog from 'resource:///org/gnome/shell/ui/modalDialog.js';
import {formatValue} from './network.js';
import {drawWorldMap, mapPoints, hitTest} from './worldMap.js';

function label(text, styleClass = 'topbar-network-connection-caption', props = {}) {
    const actor = new St.Label({text, style_class: styleClass, ...props});
    actor.clutter_text.ellipsize = Pango.EllipsizeMode.END;
    return actor;
}

function wrapped(text, styleClass) {
    const actor = label(text, styleClass);
    actor.clutter_text.line_wrap = true;
    actor.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
    return actor;
}

export const ConnectionDialog = GObject.registerClass(
class ConnectionDialog extends ModalDialog.ModalDialog {
    _init({snapshot, land, settings, onSettings, onClosed}) {
        super._init({styleClass: 'topbar-network-connections-dialog', destroyOnClose: true});
        this._snapshot = snapshot;
        this._land = land;
        this._settings = settings;
        this._selected = null;
        this._rows = new Map();
        this._destroyed = false;
        const monitor = Main.layoutManager.primaryMonitor;
        const width = Math.min(820, (monitor?.width ?? 1024) - 100);
        const availableHeight = (monitor?.height ?? 768) - 180;
        this.contentLayout.width = width;
        this.contentLayout.set_text_direction(Clutter.TextDirection.LTR);
        this.contentLayout.add_style_class_name('topbar-network-connections-content');
        const heading = new St.BoxLayout();
        heading.add_child(label('Where your traffic goes', 'topbar-network-connections-title', {x_expand: true}));
        this._live = label('', 'topbar-network-connection-live');
        heading.add_child(this._live);
        this.contentLayout.add_child(heading);
        this._status = wrapped('', 'topbar-network-connection-caption');
        this.contentLayout.add_child(this._status);
        this._map = new St.DrawingArea({width, height: Math.max(100, Math.min(240, Math.floor(availableHeight * 0.32))),
            x_expand: true, reactive: true, can_focus: true,
            style_class: 'topbar-network-world-map',
            accessible_name: 'World connections. Use Left and Right to select a destination.'});
        this._map.set_text_direction(Clutter.TextDirection.LTR);
        this._map.connect('repaint', area => {
            const cr = area.get_context();
            try {
                const [w, h] = area.get_surface_size();
                drawWorldMap(cr, w, h, this._land, this._visibleTargets ?? [], this._data?.origin, this._selected);
            } finally { cr.$dispose(); }
        });
        this._map.connect('button-press-event', (_actor, event) => {
            const [x, y] = event.get_coords();
            const [ok, localX, localY] = this._map.transform_stage_point(x, y);
            if (ok) {
                const key = hitTest(mapPoints(this._visibleTargets ?? [], this._map.width, this._map.height), localX, localY);
                if (key) this.select(key);
            }
            return Clutter.EVENT_STOP;
        });
        this._map.connect('key-press-event', (_actor, event) => {
            const key = event.get_key_symbol();
            if (![Clutter.KEY_Left, Clutter.KEY_Right, Clutter.KEY_Home, Clutter.KEY_End].includes(key))
                return Clutter.EVENT_PROPAGATE;
            const targets = this._visibleTargets ?? [];
            const current = targets.findIndex(t => t.key === this._selected);
            const next = key === Clutter.KEY_Home ? 0 : key === Clutter.KEY_End ? targets.length - 1
                : Math.max(0, Math.min(targets.length - 1, current + (key === Clutter.KEY_Left ? -1 : 1)));
            if (targets[next]) this.select(targets[next].key);
            return Clutter.EVENT_STOP;
        });
        this.contentLayout.add_child(this._map);
        this._legend = wrapped('', 'topbar-network-connection-caption');
        this.contentLayout.add_child(this._legend);
        this._search = new St.Entry({hint_text: 'Search domain, IP, country or app…', can_focus: true,
            style_class: 'topbar-network-connection-search'});
        this._search.clutter_text.connect('text-changed', () => this.update());
        this.contentLayout.add_child(this._search);
        const columns = new St.BoxLayout({style_class: 'topbar-network-connection-columns topbar-network-connection-header'});
        columns.add_child(label('DESTINATION', 'topbar-network-connection-caption', {x_expand: true}));
        columns.add_child(label('COUNTRY', 'topbar-network-connection-caption', {width: 160}));
        columns.add_child(label('SESSION ↓ + ↑', 'topbar-network-connection-caption', {width: 116}));
        this.contentLayout.add_child(columns);
        this._list = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, x_expand: true});
        this._scroll = new St.ScrollView({height: Math.max(72, Math.min(160, Math.floor(availableHeight * 0.22))),
            style_class: 'topbar-network-connection-scroll', x_expand: true,
            hscrollbar_policy: St.PolicyType.NEVER});
        this._scroll.set_child(this._list);
        this.contentLayout.add_child(this._scroll);
        this._empty = wrapped('', 'topbar-network-connection-caption');
        this.contentLayout.add_child(this._empty);
        this._detail = wrapped('', 'topbar-network-connection-detail');
        this._detail.clutter_text.set_selectable(true);
        this._detail.width = width;
        const detailBox = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, x_expand: true});
        detailBox.add_child(this._detail);
        this._detailScroll = new St.ScrollView({height: Math.max(75, Math.min(112, Math.floor(availableHeight * 0.18))),
            hscrollbar_policy: St.PolicyType.NEVER, x_expand: true});
        this._detailScroll.set_child(detailBox);
        this.contentLayout.add_child(this._detailScroll);
        this._footnote = wrapped('', 'topbar-network-connection-caption');
        this.contentLayout.add_child(this._footnote);
        this.setButtons([
            {label: 'Network Settings', action: () => { this.close(); onSettings(); }},
            {label: 'Close', default: true, key: Clutter.KEY_Escape, action: () => this.close()},
        ]);
        this.setInitialKeyFocus(this._search);
        this.connect('closed', () => { this._destroyed = true; onClosed(); });
        this.update();
    }

    select(key) {
        this._selected = key;
        this.update();
    }

    update() {
        if (this._destroyed) return;
        const data = this._snapshot();
        this._data = data;
        const search = this._search.get_text().trim().toLowerCase();
        const matching = data.targets.filter(t => !search || [t.displayHost, t.host, t.country,
            ...t.endpoints.map(e => e.ip), ...t.apps].join(' ').toLowerCase().includes(search));
        const targets = matching.slice(0, 150);
        this._visibleTargets = targets;
        if (!targets.some(t => t.key === this._selected)) this._selected = targets[0]?.key ?? null;
        const active = data.targets.reduce((n, t) => n + t.active, 0);
        this._live.text = `${active} live · ${data.targets.length} targets`;
        this._status.text = data.status;
        const located = targets.filter(t => t.endpoints.some(e => e.geo)).length;
        this._legend.text = `Blue: destinations · Orange: public exit${data.origin ? ' (' + data.origin.country + ')' : ' (unavailable)'}\n` +
            `${located} of ${targets.length} shown targets located · Approximate IP locations · Dashed: DNS estimate`;
        this._map.accessible_name = `World connections. ${this._legend.text}. Use Left and Right to select a destination.`;
        const keys = new Set(targets.map(t => t.key));
        for (const [key, row] of this._rows) {
            if (!keys.has(key)) { row.button.destroy(); this._rows.delete(key); }
        }
        for (const [index, target] of targets.entries()) {
            let row = this._rows.get(target.key);
            if (!row) {
                const button = new St.Button({can_focus: true, x_expand: true,
                    style_class: 'topbar-network-connection-row'});
                const box = new St.BoxLayout({style_class: 'topbar-network-connection-columns',
                    width: this.contentLayout.width - 20, x_expand: true, x_align: Clutter.ActorAlign.FILL});
                const host = label('', 'topbar-network-connection-host', {x_expand: true,
                    width: this.contentLayout.width - 328});
                const country = label('', 'topbar-network-connection-caption', {width: 160});
                const total = label('', 'topbar-network-connection-total', {width: 116});
                box.add_child(host); box.add_child(country); box.add_child(total);
                button.set_child(box);
                button.connect('clicked', () => this.select(target.key));
                this._list.add_child(button);
                row = {button, host, country, total};
                this._rows.set(target.key, row);
            }
            this._list.set_child_at_index(row.button, index);
            row.host.text = `${target.active ? '●' : '○'}  ${target.displayHost}`;
            row.country.text = target.country;
            row.total.text = formatValue(target.rx + target.tx, false, false);
            row.button.accessible_name = `${target.displayHost}, ${target.country}, ${row.total.text}, ${target.active} live connections`;
            if (target.key === this._selected) row.button.add_style_pseudo_class('checked');
            else row.button.remove_style_pseudo_class('checked');
        }
        this._empty.text = !targets.length ? (search ? 'No matching destinations.' : 'Waiting for traffic. Existing connections start from zero.')
            : matching.length > targets.length ? `Showing the busiest ${targets.length} of ${matching.length} matches. Search to narrow the list.` : '';
        this._empty.visible = !!this._empty.text;
        const selected = targets.find(t => t.key === this._selected);
        const bits = this._settings.get_boolean('show-bits');
        if (selected) {
            const ips = selected.endpoints.slice(0, 4).map(e => `${e.ip.includes(':') && e.port ? '[' + e.ip + ']' : e.ip}${e.port ? ':' + e.port : ''}` +
                ` · ${e.location}${e.estimated ? ' · DNS estimate' : ''}`).join('\n');
            const kind = selected.kind === 'proxy-endpoint' ? 'Proxy endpoint · original targets require the controller API'
                : selected.reverseDNS ? 'Reverse DNS name' : 'Destination';
            this._detail.text = `${selected.displayHost} · ${kind}\n${ips || 'IP not reported by proxy (remote DNS)'}\n` +
                `Apps: ${[...selected.apps].slice(0, 4).join(', ')} · ${[...selected.networks].join(', ')} · ${selected.active} live\n` +
                `↑ ${formatValue(selected.txRate, bits)}   ↓ ${formatValue(selected.rxRate, bits)}   ·   ` +
                `Session ↑ ${formatValue(selected.tx, false, false)}   ↓ ${formatValue(selected.rx, false, false)}\n` +
                `Route: ${[...selected.routes].slice(0, 2).join('; ') || 'Not reported'}`;
        } else {
            this._detail.text = 'Choose a destination to inspect its IP, country, apps and traffic.';
        }
        this._footnote.text = (data.geolocation
            ? 'Locations: ipwho.is · Public IPs only · World map: Natural Earth'
            : 'Location lookups are off. Enable them in Network Settings to populate the map.') +
            (data.dns ? '\nDNS estimates use your system resolver and can differ from the proxy’s resolved IP.' : '') +
            (data.locationStatus ? '\n' + data.locationStatus : '') +
            (data.dropped ? '\nSession capacity reached (2,000 targets); some targets may be omitted.' : '');
        this._map.queue_repaint();
    }
});
