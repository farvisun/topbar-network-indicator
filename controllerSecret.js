import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

function tokenFile() {
    return Gio.File.new_for_path(GLib.build_filenamev([GLib.get_user_config_dir(), 'topbar-network', 'controller.token']));
}

export function readControllerSecret() {
    try {
        const [, data] = tokenFile().load_contents(null);
        if (data.length > 4096) return '';
        return new TextDecoder().decode(data).trim();
    } catch {
        return '';
    }
}

export function writeControllerSecret(secret) {
    const file = tokenFile();
    GLib.mkdir_with_parents(file.get_parent().get_path(), 0o700);
    // Replace the inode and use PRIVATE so even an older permissive file becomes
    // mode 0600. The token never goes into GSettings, logs, or subprocess arguments.
    file.replace_contents(secret.trim(), null, false,
        Gio.FileCreateFlags.PRIVATE | Gio.FileCreateFlags.REPLACE_DESTINATION, null);
}
