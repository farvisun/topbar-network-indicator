import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';
import {HistoryPage} from './historyPage.js';
import {controllerURL} from './connections.js';
import {readControllerSecret, writeControllerSecret} from './controllerSecret.js';
import {parseCounters} from './network.js';
import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

const AUTOMATIC = 'Automatic';

function detectedInterfaces() {
    try {
        const [, contents] = GLib.file_get_contents('/proc/net/dev');
        return [...parseCounters(new TextDecoder().decode(contents)).keys()].sort();
    } catch {
        return [];
    }
}

function toast(window, title) {
    window.add_toast?.(new Adw.Toast({title, timeout: 3}));
}

function setupHelp() {
    const steps = [
        'Throne owns outgoing proxy sockets, so socket statistics only show ThroneCore.',
        '1.  In Throne, open Basic Settings → Sing-box and enable Clash API.',
        '2.  Choose a local port and, optionally, a secret.',
        '3.  Enter the same address and secret here.',
        '4.  Restart the running Throne profile.',
    ];
    const box = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL, spacing: 6,
        margin_top: 12, margin_bottom: 12, margin_start: 12, margin_end: 12, width_request: 320});
    const title = new Gtk.Label({label: 'Connect Throne', xalign: 0});
    title.add_css_class('heading');
    box.append(title);
    for (const [index, text] of steps.entries()) {
        const line = new Gtk.Label({label: text, xalign: 0, wrap: true, max_width_chars: 44});
        if (index === 0) line.add_css_class('dim-label');
        box.append(line);
    }
    const button = new Gtk.MenuButton({icon_name: 'help-about-symbolic', valign: Gtk.Align.CENTER,
        tooltip_text: 'How to connect Throne', popover: new Gtk.Popover({child: box})});
    button.add_css_class('flat');
    return button;
}

export default class NetworkPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        window.set_default_size(760, 820);
        window.search_enabled = true;
        const page = new Adw.PreferencesPage({name: 'network', title: 'Network',
            icon_name: 'network-transmit-receive-symbolic'});

        // ── Top bar ──────────────────────────────────────────
        const display = new Adw.PreferencesGroup({title: 'Top Bar',
            description: 'How the live indicator appears in the panel.'});
        const position = new Adw.ComboRow({title: 'Position',
            subtitle: 'Panel area that holds the indicator',
            model: Gtk.StringList.new(['Left', 'Center', 'Right'])});
        settings.bind('position', position, 'selected', Gio.SettingsBindFlags.DEFAULT);
        display.add(position);
        const units = new Adw.ComboRow({title: 'Speed units',
            model: Gtk.StringList.new(['Bytes — kB/s, MB/s', 'Bits — kb/s, Mb/s'])});
        const syncUnits = () => { units.selected = settings.get_boolean('show-bits') ? 1 : 0; };
        syncUnits();
        units.connect('notify::selected', () => {
            if (settings.get_boolean('show-bits') !== (units.selected === 1))
                settings.set_boolean('show-bits', units.selected === 1);
        });
        display.add(units);
        const interval = new Adw.SpinRow({title: 'Refresh interval', subtitle: 'Seconds between samples',
            adjustment: new Gtk.Adjustment({lower: 1, upper: 5, step_increment: 1})});
        settings.bind('refresh-interval', interval, 'value', Gio.SettingsBindFlags.DEFAULT);
        display.add(interval);
        page.add(display);

        // ── Monitoring ───────────────────────────────────────
        const monitoring = new Adw.PreferencesGroup({title: 'Monitoring',
            description: 'Session totals reset when the extension is disabled or you log out. Saved history is kept separately.'});
        const saved = settings.get_string('interface').trim();
        const names = detectedInterfaces();
        if (saved && !names.includes(saved))
            names.push(saved);
        const choices = [AUTOMATIC, ...names];
        const iface = new Adw.ComboRow({title: 'Network interface',
            subtitle: 'Automatic follows physical adapters, or the default route on virtual machines. Choose one explicitly for a VPN or bridge.',
            model: Gtk.StringList.new(choices), enable_search: choices.length > 8});
        iface.selected = Math.max(0, choices.indexOf(saved || AUTOMATIC));
        iface.connect('notify::selected', () => {
            const value = iface.selected > 0 ? choices[iface.selected] : '';
            if (value !== settings.get_string('interface'))
                settings.set_string('interface', value);
        });
        monitoring.add(iface);
        page.add(monitoring);

        // ── Proxy destinations ───────────────────────────────
        const destinations = new Adw.PreferencesGroup({title: 'Proxy Destinations',
            description: 'Read original targets from Throne’s Clash API instead of the proxy’s own sockets.',
            header_suffix: setupHelp()});
        const controller = new Adw.EntryRow({title: 'Clash API address', show_apply_button: true,
            text: settings.get_string('proxy-controller'), input_purpose: Gtk.InputPurpose.URL});
        controller.connect('apply', () => {
            try {
                const url = controllerURL(controller.text);
                settings.set_string('proxy-controller', url);
                controller.remove_css_class('error');
                controller.set_tooltip_text(null);
                toast(window, 'Controller saved — reconnecting');
            } catch (error) {
                controller.add_css_class('error');
                controller.set_tooltip_text(error.message);
                toast(window, error.message);
            }
        });
        destinations.add(controller);
        const secret = new Adw.PasswordEntryRow({title: 'Controller secret (optional)', show_apply_button: true,
            text: readControllerSecret()});
        secret.connect('apply', () => {
            try {
                if (/[\r\n]/.test(secret.text) || secret.text.length > 4096)
                    throw new Error('Enter a single controller secret, up to 4096 characters.');
                writeControllerSecret(secret.text);
                settings.set_int('controller-secret-generation', (settings.get_int('controller-secret-generation') + 1) % 2147483647);
                secret.remove_css_class('error');
                secret.set_tooltip_text('Stored privately in ~/.config/topbar-network/controller.token (mode 0600)');
                toast(window, 'Secret saved privately');
            } catch (error) {
                secret.add_css_class('error');
                secret.set_tooltip_text(error.message);
                toast(window, error.message);
            }
        });
        destinations.add(secret);
        page.add(destinations);

        // ── Privacy ──────────────────────────────────────────
        const privacy = new Adw.PreferencesGroup({title: 'Lookups and Privacy',
            description: 'Lookups run only while destinations are on screen. Results stay in memory; the world map is bundled locally.'});
        const location = new Adw.SwitchRow({title: 'Country and map location lookups',
            subtitle: 'Queries ipwho.is over HTTPS for public IP addresses'});
        settings.bind('geolocation-enabled', location, 'active', Gio.SettingsBindFlags.DEFAULT);
        privacy.add(location);
        const dns = new Adw.SwitchRow({title: 'Resolve destination names',
            subtitle: 'Uses system DNS. Unreported proxy IPs are marked “DNS estimate”; reverse names may differ from the requested domain.'});
        settings.bind('resolve-domains', dns, 'active', Gio.SettingsBindFlags.DEFAULT);
        privacy.add(dns);
        page.add(privacy);

        window.add(page);
        const history = new HistoryPage(window, settings);
        window.add(history.page);
        const selectPage = () => {
            window.set_visible_page_name(settings.get_string('preferences-page') === 'history' ? 'history' : 'network');
        };
        const ids = [
            settings.connect('changed::preferences-page', selectPage),
            settings.connect('changed::show-bits', syncUnits),
        ];
        window.connect('close-request', () => { ids.forEach(id => settings.disconnect(id)); return false; });
        selectPage();
    }
}
