// Equirectangular world map. Land geometry is bundled; no tile service is used.
const BLUE = [0.38, 0.69, 0.98];
const ORANGE = [0.98, 0.65, 0.28];

export function project(longitude, latitude, width, height) {
    return [(longitude + 180) / 360 * width, (90 - latitude) / 180 * height];
}

export function mapPoints(targets, width, height) {
    return targets.flatMap(target => target.endpoints.filter(e => e.geo).map(endpoint => {
        const [x, y] = project(endpoint.geo.longitude, endpoint.geo.latitude, width, height);
        return {x, y, key: target.key, active: endpoint.active, estimated: endpoint.estimated,
            total: target.rx + target.tx};
    }));
}

export function hitTest(points, x, y, radius = 12) {
    return points.map(p => ({point: p, distance: Math.hypot(p.x - x, p.y - y)}))
        .filter(p => p.distance <= radius).sort((a, b) => a.distance - b.distance)[0]?.point.key ?? null;
}

// Wrap at the antimeridian so a Pacific connection takes the short way around.
export function connectionArcs(origin, destination, width, height) {
    let [x1, y1] = project(origin.longitude, origin.latitude, width, height);
    let [x2, y2] = project(destination.longitude, destination.latitude, width, height);
    if (x2 - x1 > width / 2) x2 -= width;
    if (x1 - x2 > width / 2) x2 += width;
    const lift = Math.min(height * 0.25, Math.abs(x2 - x1) * 0.25 + Math.abs(y2 - y1) * 0.1);
    return [-width, 0, width].map(offset => [
        x1 + offset, y1,
        x1 + (x2 - x1) / 3 + offset, y1 + (y2 - y1) / 3 - lift,
        x1 + 2 * (x2 - x1) / 3 + offset, y1 + 2 * (y2 - y1) / 3 - lift,
        x2 + offset, y2,
    ]);
}

export function drawWorldMap(cr, width, height, land, targets, origin, selected) {
    cr.save();
    cr.rectangle(0, 0, width, height);
    cr.clip();
    cr.setSourceRGB(0.055, 0.075, 0.095);
    cr.paint();
    cr.setSourceRGBA(0.65, 0.75, 0.85, 0.09);
    cr.setLineWidth(0.6);
    for (let lon = -180; lon <= 180; lon += 30) {
        const [x] = project(lon, 0, width, height);
        cr.moveTo(x, 0); cr.lineTo(x, height);
    }
    for (let lat = -60; lat <= 60; lat += 30) {
        const [, y] = project(0, lat, width, height);
        cr.moveTo(0, y); cr.lineTo(width, y);
    }
    cr.stroke();
    for (const feature of land?.features ?? []) {
        const geometry = feature.geometry;
        const polygons = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates;
        for (const rings of polygons) {
            for (const ring of rings) {
                for (const [index, [longitude, latitude]] of ring.entries()) {
                    const [x, y] = project(longitude, latitude, width, height);
                    if (index) cr.lineTo(x, y); else cr.moveTo(x, y);
                }
                cr.closePath();
            }
            cr.setSourceRGB(0.16, 0.22, 0.27);
            cr.fillPreserve();
            cr.setSourceRGBA(0.58, 0.69, 0.79, 0.35);
            cr.setLineWidth(0.6);
            cr.stroke();
        }
    }
    // Drawing the selected connection last keeps it legible in busy regions.
    const ordered = targets.slice(0, 150).sort((a, b) => Number(a.key === selected) - Number(b.key === selected));
    for (const target of ordered) {
        const chosen = target.key === selected;
        for (const endpoint of target.endpoints) {
            if (!endpoint.geo) continue;
            const geo = endpoint.geo;
            if (origin && (endpoint.active || chosen)) {
                cr.setSourceRGBA(...BLUE, chosen ? 0.9 : 0.24);
                cr.setLineWidth(chosen ? 2 : 0.9);
                cr.setDash(endpoint.estimated ? [4, 4] : [], 0);
                for (const [x, y, ...curve] of connectionArcs(origin, geo, width, height)) {
                    cr.moveTo(x, y); cr.curveTo(...curve); cr.stroke();
                }
                cr.setDash([], 0);
            }
            const [x, y] = project(geo.longitude, geo.latitude, width, height);
            cr.setSourceRGBA(...BLUE, chosen ? 0.18 : 0.08);
            cr.arc(x, y, chosen ? 10 : 5, 0, 2 * Math.PI); cr.fill();
            cr.setSourceRGBA(...BLUE, chosen || endpoint.active ? 1 : 0.4);
            cr.arc(x, y, chosen ? 4 : 2.2, 0, 2 * Math.PI); cr.fill();
            if (chosen) {
                cr.setSourceRGBA(0.9, 0.96, 1, 0.9);
                cr.arc(x, y, 7, 0, 2 * Math.PI); cr.stroke();
            }
        }
    }
    if (origin) {
        const [x, y] = project(origin.longitude, origin.latitude, width, height);
        cr.setSourceRGBA(...ORANGE, 0.15);
        cr.arc(x, y, 10, 0, 2 * Math.PI); cr.fill();
        cr.setSourceRGB(...ORANGE);
        cr.arc(x, y, 4, 0, 2 * Math.PI); cr.fill();
    }
    cr.restore();
}
