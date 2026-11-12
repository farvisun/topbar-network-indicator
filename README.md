<h1 align="center">Topbar Network</h1>

<p align="center">
  <strong>Live network traffic, saved history and a world map of your connections,<br>right in the GNOME top bar.</strong>
</p>

<p align="center">
  <a href="https://farvisun.github.io/topbar-network-indicator/">Website</a> ·
  <a href="https://github.com/farvisun/topbar-network-indicator/releases/latest">Download</a> ·
  <a href="#install">Install</a> ·
  <a href="#faq">FAQ</a>
</p>

<p align="center">
  <img alt="GNOME Shell 50" src="https://img.shields.io/badge/GNOME%20Shell-50-4a86cf?logo=gnome&logoColor=white">
  <img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-green">
  <a href="https://github.com/farvisun/topbar-network-indicator/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/farvisun/topbar-network-indicator/actions/workflows/ci.yml/badge.svg"></a>
</p>

<p align="center">
  <img src="docs/assets/dropdown.png" alt="The Topbar Network dropdown: upload and download speeds, a live throughput chart, the top destinations and quick buttons" width="380">
</p>

## Features

- **Speeds in the top bar.** Upload and download with a small chart that never shifts the panel around.
- **Charts you can inspect.** Upload above the line, download below, for the last minute, hour, day or week. Hover any point to read it.
- **A year of history.** Browse usage by day, week, month or custom dates, and export it as CSV.
- **Top apps and destinations.** See which programs and websites used the most traffic this session.
- **World map.** An offline map of where your connections go, with optional proxy (Throne / Clash) support.
- **Private.** No telemetry, no account, no background service and no root. Your history never leaves your computer.

## Install

You need **GNOME Shell 50**.

1. Download `topbar-network@farvisun.local.shell-extension.zip` from the [latest release](https://github.com/farvisun/topbar-network-indicator/releases/latest).
2. Install it:
   ```sh
   gnome-extensions install --force topbar-network@farvisun.local.shell-extension.zip
   ```
3. **Log out and back in** so GNOME finds the extension.
4. Turn it on, in the **Extensions** app or with:
   ```sh
   gnome-extensions enable topbar-network@farvisun.local
   ```

To update, repeat steps 1–3.

## Using it

Click the speeds in the top bar to open the dropdown.

| In the dropdown | What it does |
| --- | --- |
| **Live / 1H / 24H / 7D** | Change the chart's time range. |
| Hover the chart | Read the speed at any moment. The chart holds still while you look. Use ←/→ when it has focus. |
| **Destinations / Apps** | Switch the ranking between websites and programs. |
| **Connections** | Open the searchable destination list and world map. |
| **History** | Open saved usage by day, week, month or a custom range. |
| Eraser button | Reset this session's totals. Saved history is kept. |
| Gear button | Open Settings. |

**Settings** covers the panel position, bits or bytes, refresh rate, which network interface to watch, how long to keep history (7 days to 1 year), and the proxy and location options.

<details>
<summary><b>See real website names behind a proxy (Throne, sing-box, Clash)</b></summary>

A proxy hides the real destinations from the system. If your proxy offers a Clash API, Topbar Network can read the real names from it:

1. In Throne, open **Settings → Basic Settings → Sing-box → Clash API**. Set the address to `127.0.0.1` and the port to `9090`, copy the secret if there is one, and restart the profile.
2. In Topbar Network **Settings → Proxy Destinations**, enter `http://127.0.0.1:9090` and the secret, and press **Apply** on each field.
3. Open **Connections** from the dropdown. New traffic appears as it happens.

The connection is read-only and only works with addresses on your own computer. The secret is stored in a private file, not in GNOME settings.
</details>

## Privacy

Speeds and history are measured locally from the Linux kernel, and history is saved only in `~/.local/share/topbar-network/`.

Two optional features use the network. You can turn each one off in Settings:

- **Country and map locations** look up public destination IP addresses with `ipwho.is`. Website names are never sent.
- **Name lookups** use your normal DNS resolver to turn IP addresses into names.

## FAQ

**The extension doesn't appear after installing.**
Log out and back in. On Wayland, GNOME only loads new extensions at login. Check its status with `gnome-extensions info topbar-network@farvisun.local`.

**The speeds look wrong, or count my VPN twice.**
By default, Topbar Network adds up your physical network cards and ignores virtual ones. If you use bridges, containers or unusual routing, choose an interface in **Settings** (list them with `ip -brief link`).

**Is anything recorded while I'm logged out?**
No. There is no background service, so history only covers the time you were logged in with the extension on. After suspend, the chart shows a gap instead of a false spike.

**How do I delete my history?**
Open **History** and choose **Clear…**. Resetting session totals does not touch saved history.

**Why is a proxy app such as ThroneCore my top app?**
A proxy handles traffic for other apps. Connect its Clash API (see above) to see the real destinations.

## Uninstall

```sh
gnome-extensions uninstall topbar-network@farvisun.local
```

To remove saved history as well, clear it in **History** first, or delete `~/.local/share/topbar-network/`.

## Development

```sh
./build.sh                                  # builds dist/topbar-network@farvisun.local.shell-extension.zip
for t in network chart apps connections history connectionMonitor; do gjs -m tests/$t.js; done
dbus-run-session -- gnome-shell-test-tool --headless \
  --extension dist/topbar-network@farvisun.local.shell-extension.zip tests/shell.js
```

The shell test runs a private, headless GNOME Shell and never touches your desktop settings. Setting `TOPBAR_NETWORK_MENU_SCREENSHOT=file.png` saves a documentation screenshot that uses made-up traffic only. Please run the checks before opening a pull request, and never include real traffic, destinations or secrets in screenshots or bug reports.

## License

[MIT](LICENSE) © 2026 Mohammad Askari. Map data: [Natural Earth](https://www.naturalearthdata.com/about/terms-of-use/) (public domain).
