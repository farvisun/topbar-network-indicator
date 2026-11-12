import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=4.0';
import {HistoryPage} from '../historyPage.js';

function check(value, message) {
    if (!value) throw new Error(message);
}
function sleep(ms) {
    return new Promise(resolve => GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms,
        () => { resolve(); return GLib.SOURCE_REMOVE; }));
}
Adw.init();
const source = Gio.SettingsSchemaSource.new_from_directory(`${GLib.get_current_dir()}/schemas`,
    Gio.SettingsSchemaSource.get_default(), false);
const settings = new Gio.Settings({settings_schema: source.lookup('org.gnome.shell.extensions.topbar-network', false)});
const root = GLib.dir_make_tmp('topbar-network-preferences-XXXXXX');
const window = new Adw.PreferencesWindow({default_width: 720, default_height: 760});
const history = new HistoryPage(window, settings, {root});
window.add(history.page);
window.present();
try {
    await history.refresh();
    check(history._data && history._rows.length === 0, 'Empty History page loads');
    const now = Math.floor(Date.now() / 1000) - 10;
    history.store.add(now, now + 5, 1000000, 500000, 'Automatic: eth0');
    await history.store.flush();
    await history.refresh();
    check(history._data.rx === 1000000 && history._export.sensitive, 'History page shows saved totals and enables export');
    history._selection = history._data.points.findIndex(point => point.duration);
    history._renderDetail();
    check(history._detailMeta.label.includes('eth0'), 'Inspection exposes interface configuration');
    for (const mode of [1, 2, 3, 0]) {
        history._mode.active = mode;
        await history.refresh();
        check(history._data.rx === 1000000, 'Calendar modes include current observations');
    }
    history._customStart = new Date(2030, 0, 2);
    history._customEnd = new Date(2030, 0, 1);
    history._mode.active = 3;
    await history.refresh();
    check(!history._data && !history._export.sensitive, 'Reversed dates disable export');
    history._mode.active = 0;
    settings.set_boolean('show-bits', true);
    await history.refresh();
    check(history._scale.label.includes('b/s'), 'Bits setting updates historical chart units');
    Gtk.Widget.set_default_direction(Gtk.TextDirection.RTL);
    await sleep(300);
    check(history._chart.get_direction() === Gtk.TextDirection.LTR, 'Chart retains chronological LTR layout on RTL desktop');
    history._confirmClear();
    await sleep(200);
    // Keep the confirmation open briefly to catch construction and layout errors.
    const dialog = window.get_visible_dialog();
    check(dialog instanceof Adw.AlertDialog, 'Clear history uses a confirmation dialog');
    dialog.emit('response', 'cancel');
    dialog.force_close();
    await sleep(100);
    check(history._data.rx === 1000000, 'Cancel keeps saved history');
    history._confirmClear();
    window.get_visible_dialog().emit('response', 'clear');
    window.get_visible_dialog()?.force_close();
    await sleep(300);
    await history.refresh();
    check(history._data.rx === 0 && !history._export.sensitive, 'Confirmed clear empties history');
    print('GTK History page: loading, totals, calendar views, inspection, validation, bits, RTL and clear confirmation passed');
} finally {
    window.close();
    history.close();
    settings.set_string('history-generation', GLib.uuid_string_random());
    await history.store.prune();
    Gio.File.new_for_path(root).delete(null);
}
