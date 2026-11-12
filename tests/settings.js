import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=4.0';
import {readControllerSecret} from '../controllerSecret.js';

function check(value, message) { if (!value) throw new Error(message); }
function sleep(ms) { return new Promise(resolve => GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms,
    () => { resolve(); return GLib.SOURCE_REMOVE; })); }
function walk(widget) {
    const all = [widget];
    for (let child = widget.get_first_child(); child; child = child.get_next_sibling()) all.push(...walk(child));
    return all;
}
Adw.init();
const resource = Gio.Resource.load('/usr/share/gnome-shell/org.gnome.Shell.Extensions.src.gresource');
resource._register();
const {default: Preferences} = await import('../prefs.js');
const path = GLib.get_current_dir();
check(GLib.get_user_config_dir().startsWith(GLib.get_tmp_dir() + '/') &&
    GLib.get_user_data_dir().startsWith(GLib.get_tmp_dir() + '/'),
'This test writes a dummy API secret; set XDG_CONFIG_HOME and XDG_DATA_HOME to temporary directories.');
const [, contents] = Gio.File.new_for_path(`${path}/metadata.json`).load_contents(null);
const metadata = {...JSON.parse(new TextDecoder().decode(contents)), path, dir: Gio.File.new_for_path(path)};
const preferences = new Preferences(metadata);
const settings = preferences.getSettings();
const window = new Adw.PreferencesWindow();
preferences.fillPreferencesWindow(window);
window.present();
try {
    await sleep(200);
    const widgets = walk(window);
    const address = widgets.find(w => w instanceof Adw.EntryRow && w.title === 'Clash API address');
    const secret = widgets.find(w => w instanceof Adw.PasswordEntryRow);
    const geolocation = widgets.find(w => w instanceof Adw.SwitchRow && w.title === 'Country and map location lookups');
    check(address && secret && geolocation, 'Full preferences entry point contains proxy and location settings');
    address.text = 'http://remote.example:9090';
    address.emit('apply');
    check(address.has_css_class('error') && settings.get_string('proxy-controller') === 'http://127.0.0.1:9090',
        'Invalid controller addresses show validation and leave the saved value intact');
    address.text = 'http://127.0.0.1:12345';
    address.emit('apply');
    check(settings.get_string('proxy-controller') === address.text && !address.has_css_class('error'),
        'Valid controller settings are applied');
    secret.text = 'integration-test-token';
    secret.emit('apply');
    check(readControllerSecret() === 'integration-test-token', 'Controller password is saved outside GSettings');
    const file = Gio.File.new_for_path(`${GLib.get_user_config_dir()}/topbar-network/controller.token`);
    file.set_attribute_uint32('unix::mode', 0o644, Gio.FileQueryInfoFlags.NONE, null);
    secret.text = 'replacement-test-token';
    secret.emit('apply');
    check((file.query_info('unix::mode', Gio.FileQueryInfoFlags.NONE, null).get_attribute_uint32('unix::mode') & 0o777) === 0o600,
        'Controller token permissions are 0600');
    geolocation.active = false;
    check(!settings.get_boolean('geolocation-enabled'), 'Location switch updates settings');
    settings.set_string('preferences-page', 'history');
    check(window.visible_page_name === 'history', 'History navigation remains functional');
    settings.set_string('preferences-page', 'network');
    Gtk.Widget.set_default_direction(Gtk.TextDirection.RTL);
    await sleep(100);
    print('Preferences entry point: proxy validation, private token storage, lookup switches, history navigation and RTL passed');
} finally {
    window.close();
    await sleep(100);
}
