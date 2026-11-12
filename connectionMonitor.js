import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Soup from 'gi://Soup?version=3.0';
import {ConnectionTraffic, socketConnections, parseProxyConnections, controllerURL,
    ipKind, cleanText} from './connections.js';
import {readControllerSecret} from './controllerSecret.js';

const now = () => GLib.get_monotonic_time() / 1_000_000;
const LOCATION_FIELDS = 'ip,success,country,country_code,latitude,longitude';

export function parseLocation(data) {
    if (data?.success !== true || typeof data.country !== 'string' || !data.country ||
        !Number.isFinite(data.latitude) || Math.abs(data.latitude) > 90 ||
        !Number.isFinite(data.longitude) || Math.abs(data.longitude) > 180)
        return null;
    return {country: cleanText(data.country, 100), code: cleanText(data.country_code, 2),
        latitude: data.latitude, longitude: data.longitude};
}

export class ConnectionMonitor {
    constructor(settings, changed) {
        this.settings = settings;
        this.changed = changed;
        this.traffic = new ConnectionTraffic();
        this._localSession = new Soup.Session({timeout: 4,
            proxy_resolver: Gio.SimpleProxyResolver.new(null, [])});
        this._geoSession = new Soup.Session({timeout: 10});
        this._closed = false;
        this._sockets = new Map();
        this._dns = new Map();
        this._locations = new Map();
        this._dnsBusy = 0;
        this._geoBusy = false;
        this._nextGeo = 0;
        this._originAt = -Infinity;
        this._lookupCount = 0;
        this._lookupDay = new Date().toISOString().slice(0, 10);
        this.origin = null;
        this.locationStatus = '';
        this.configure();
    }

    configure() {
        this._request?.cancel();
        this._request = null;
        this._enrichment?.cancel();
        this._enrichment = new Gio.Cancellable();
        this._dnsBusy = 0;
        this._geoBusy = false;
        // Pending records belong to cancelled lookups, not to the new settings.
        for (const [key, value] of this._dns) if (value.pending) this._dns.delete(key);
        for (const [key, value] of this._locations) if (value.pending) this._locations.delete(key);
        this._secret = readControllerSecret();
        this.proxyConnected = false;
        this._nextPoll = 0;
        this.traffic.disconnect('proxy');
        this.status = 'Connecting to the local proxy controller…';
        try {
            this._url = controllerURL(this.settings.get_string('proxy-controller'));
        } catch (error) {
            this._url = null;
            this.status = error.message;
        }
        if (!this.settings.get_boolean('geolocation-enabled')) {
            this.origin = null;
            this._originAt = -Infinity;
        }
    }

    reset() {
        this.configure();
        this.traffic.reset();
        this.poll();
    }

    updateSockets(sockets, time) {
        if (this._closed) return;
        this._sockets = sockets;
        // A transport socket reappearing after a controller outage already has
        // lifetime counters. Rebaseline this stream when changing coverage so
        // those old bytes cannot suddenly become new destination traffic.
        if (this._socketMode !== this.proxyConnected)
            this.traffic.disconnect('sockets');
        this._socketMode = this.proxyConnected;
        this.traffic.sample('sockets', socketConnections(sockets, this.proxyConnected), time);
        this._notify();
    }

    socketError() {
        this._sockets = new Map();
        this.traffic.disconnect('sockets');
        this._notify();
    }

    setVisible(summary, details = false) {
        this._summary = summary;
        this._details = details;
        if (summary || details) this._enrich();
    }

    async _json(session, url, cancellable, secret = '') {
        const message = Soup.Message.new('GET', url);
        // Do not forward a local controller's secret to a redirect target.
        message.set_flags(Soup.MessageFlags.NO_REDIRECT);
        if (secret) message.request_headers.append('Authorization', `Bearer ${secret}`);
        const data = await new Promise((resolve, reject) => {
            session.send_and_read_async(message, GLib.PRIORITY_DEFAULT, cancellable, (source, result) => {
                try { resolve(source.send_and_read_finish(result)); }
                catch (error) { reject(error); }
            });
        });
        if (message.status_code !== 200) {
            const error = new Error(`HTTP ${message.status_code}`);
            error.status = message.status_code;
            throw error;
        }
        if (data.get_size() > 8 * 1024 * 1024) throw new Error('Connection response too large');
        return JSON.parse(new TextDecoder().decode(data.get_data()));
    }

    async poll() {
        if (this._closed) return;
        this._enrich();
        if (this._request || !this._url || now() < this._nextPoll) return;
        const cancellable = new Gio.Cancellable();
        this._request = cancellable;
        try {
            const data = await this._json(this._localSession, `${this._url}/connections`, cancellable, this._secret);
            if (this._closed || this._request !== cancellable) return;
            const connections = parseProxyConnections(data, this._sockets);
            this.traffic.sample('proxy', connections, now());
            this.proxyConnected = true;
            this.status = `Proxy targets connected · ${connections.size} live connections · TCP + UDP`;
        } catch (error) {
            if (this._closed || this._request !== cancellable) return;
            this.proxyConnected = false;
            this.traffic.disconnect('proxy');
            this.status = error.status === 401 || error.status === 403
                ? 'Controller authentication failed. Set the matching secret in Network Settings.'
                : 'Proxy targets unavailable. Enable Clash API in Throne and set its address in Network Settings.';
            this._nextPoll = now() + 15;
        } finally {
            if (!this._closed && this._request === cancellable) {
                this._request = null;
                this._notify();
            }
        }
    }

    snapshot(limit = 2000) {
        const useGeo = this.settings.get_boolean('geolocation-enabled');
        const useDNS = this.settings.get_boolean('resolve-domains');
        const targets = this.traffic.top().filter(t => !this.proxyConnected || t.kind !== 'proxy-endpoint')
            .slice(0, limit).map(target => {
                let endpoints = [...target.ips].map(([ip, port]) => ({ip, port, estimated: false,
                    active: target.activeIPs.has(ip)}));
                const dns = useDNS ? this._dns.get(target.host || endpoints[0]?.ip) : null;
                if (!endpoints.some(e => ipKind(e.ip) === 'public') && target.host && dns?.ips?.length)
                    endpoints = endpoints.concat(dns.ips.map(ip => ({ip, port: '', estimated: true, active: target.active > 0})));
                endpoints = endpoints.map(endpoint => ({...endpoint,
                    geo: useGeo ? this._locations.get(endpoint.ip)?.geo ?? null : null,
                    location: ipKind(endpoint.ip) === 'local' ? 'Local network'
                        : ipKind(endpoint.ip) === 'virtual' ? 'Proxy virtual IP'
                        : !useGeo ? 'Location lookups off'
                        : this._locations.get(endpoint.ip)?.geo?.country || 'Location unavailable',
                }));
                return {...target, displayHost: target.host || dns?.host || endpoints[0]?.ip || 'Unreported target',
                    reverseDNS: !target.host && !!dns?.host, endpoints,
                    country: [...new Set(endpoints.map(e => e.location))].join(', ') || 'IP not reported'};
            });
        return {targets, proxyConnected: this.proxyConnected, status: this.status,
            origin: useGeo ? this.origin : null, locationStatus: this.locationStatus,
            geolocation: useGeo, dns: useDNS, dropped: this.traffic.dropped};
    }

    _notify() {
        if (!this._closed) this.changed();
    }

    _enrich() {
        if (this._closed || (!this._summary && !this._details)) return;
        const token = this._enrichment;
        const targets = this.snapshot(this._details ? 100 : 5).targets;
        if (this.settings.get_boolean('resolve-domains')) {
            for (const target of targets) {
                if (this._dnsBusy >= 2) break;
                const forward = target.host && !target.endpoints.some(e => ipKind(e.ip) === 'public' && !e.estimated);
                const key = forward ? target.host : !target.host && target.endpoints.find(e => ipKind(e.ip) === 'public')?.ip;
                if (!key) continue;
                const cached = this._dns.get(key);
                if (cached && (cached.pending || now() - cached.at < 3600)) continue;
                if (this._dns.size >= 2000) this._dns.delete(this._dns.keys().next().value);
                this._dns.set(key, {pending: true, at: now()});
                this._dnsBusy++;
                const resolver = Gio.Resolver.get_default();
                const finished = (source, result) => {
                    let value = {at: now()};
                    try {
                        if (forward) value.ips = source.lookup_by_name_finish(result).map(a => a.to_string())
                            .filter(ip => ipKind(ip) === 'public').slice(0, 4);
                        else value.host = cleanText(source.lookup_by_address_finish(result));
                    } catch { /* Negative lookups are cached too. */ }
                    if (this._closed || token !== this._enrichment) return;
                    this._dnsBusy--;
                    this._dns.set(key, value);
                    this._notify();
                };
                if (forward) resolver.lookup_by_name_async(key, token, finished);
                else resolver.lookup_by_address_async(Gio.InetAddress.new_from_string(key), token, finished);
            }
        }
        if (!this.settings.get_boolean('geolocation-enabled') || this._geoBusy || now() < this._nextGeo)
            return;
        const day = new Date().toISOString().slice(0, 10);
        if (day !== this._lookupDay) { this._lookupDay = day; this._lookupCount = 0; }
        // The free provider currently allows 1000/day; leave headroom for other
        // clients behind the same public address and cache successes per session.
        if (this._lookupCount >= 900) {
            this.locationStatus = 'Location lookup budget reached for today; cached locations remain available.';
            return;
        }
        const origin = this._details && now() - this._originAt > 600;
        const endpoint = targets.flatMap(t => t.endpoints).find(e => ipKind(e.ip) === 'public' &&
            (!this._locations.has(e.ip) || (!this._locations.get(e.ip).pending &&
                !this._locations.get(e.ip).geo && now() - this._locations.get(e.ip).at > 600)));
        if (!origin && !endpoint) return;
        const ip = origin ? '' : endpoint.ip;
        this._geoBusy = true;
        this._nextGeo = now() + 1.5;
        this._lookupCount++;
        if (origin) this._originAt = now();
        else {
            if (this._locations.size >= 2000) this._locations.delete(this._locations.keys().next().value);
            this._locations.set(ip, {pending: true, at: now()});
        }
        this._json(this._geoSession, `https://ipwho.is/${encodeURIComponent(ip)}?fields=${LOCATION_FIELDS}`, token)
            .then(data => {
                if (this._closed || token !== this._enrichment) return;
                const geo = parseLocation(data);
                if (origin) this.origin = geo;
                else this._locations.set(ip, {geo, at: now()});
                this.locationStatus = geo ? '' : 'Some endpoint locations could not be found.';
            }).catch(error => {
                if (this._closed || token !== this._enrichment) return;
                if (!origin) this._locations.set(ip, {geo: null, at: now()});
                this.locationStatus = 'Location service unavailable; IPs and traffic collection remain available.';
                if (error.status === 429) this._nextGeo = now() + 3600;
            }).finally(() => {
                if (this._closed || token !== this._enrichment) return;
                this._geoBusy = false;
                this._notify();
            });
    }

    close() {
        this._closed = true;
        this._request?.cancel();
        this._enrichment.cancel();
        this._localSession.abort();
        this._geoSession.abort();
        this.changed = null;
        this._secret = '';
    }
}
