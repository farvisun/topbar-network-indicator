import Cairo from 'cairo';

export const HISTORY_SECONDS = 60;
export const UPLOAD_COLOR = [0.98, 0.65, 0.28];
export const DOWNLOAD_COLOR = [0.38, 0.69, 0.98];

export function addSample(history, time, rx, tx) {
    history.push({time, rx, tx});
    while (history.length > 1 && history[1].time <= time - HISTORY_SECONDS)
        history.shift();
}

export const BAR_COUNT = 10;
export const BAR_SECONDS = HISTORY_SECONDS / BAR_COUNT;

// Each rate describes the interval ending at that sample. Weight overlaps by
// duration so irregular refresh intervals still produce six-second averages.
export function chartBars(history, now = history.at(-1)?.time ?? 0) {
    const bars = Array.from({length: BAR_COUNT}, () => ({rx: 0, tx: 0}));
    for (let i = 1; i < history.length; i++) {
        const point = history[i];
        const start = history[i - 1].time;
        if (point.time <= start || point.time - start >= 10 || point.gap)
            continue;
        for (let bar = 0; bar < BAR_COUNT; bar++) {
            const from = now - HISTORY_SECONDS + bar * BAR_SECONDS;
            const overlap = Math.max(0, Math.min(point.time, from + BAR_SECONDS) - Math.max(start, from));
            bars[bar].rx += point.rx * overlap / BAR_SECONDS;
            bars[bar].tx += point.tx * overlap / BAR_SECONDS;
        }
    }
    return bars;
}

export function chartScale(history) {
    return Math.max(1000, ...chartBars(history).map(point => Math.max(point.rx, point.tx)));
}

// Mirrored traffic: upload above the center line, download below it.
// The compact panel keeps its existing ten-bar geometry.
export function drawChart(cr, width, height, history, now, compact = false) {
    if (width <= 4 || height <= 4)
        return;
    const left = 2;
    const top = 2;
    const plotWidth = width - 4;
    const plotHeight = height - 4;
    const center = top + plotHeight / 2;
    const amplitude = plotHeight / 2 - 1;
    const bars = chartBars(history, now);
    const scale = Math.max(1000, ...bars.map(point => Math.max(point.rx, point.tx)));
    cr.setSourceRGBA(0.5, 0.5, 0.5, compact ? 0.12 : 0.08);
    cr.rectangle(left, top, plotWidth, plotHeight);
    cr.fill();
    if (!compact) {
        cr.setSourceRGBA(0.5, 0.5, 0.5, 0.18);
        cr.setLineWidth(1);
        for (let step = 0; step <= 4; step++) {
            const x = left + plotWidth * step / 4;
            cr.moveTo(x, top);
            cr.lineTo(x, top + plotHeight);
        }
        cr.stroke();
    }
    cr.setSourceRGBA(0.65, 0.65, 0.65, 0.65);
    cr.setLineWidth(1);
    cr.moveTo(left, center);
    cr.lineTo(left + plotWidth, center);
    cr.stroke();
    cr.rectangle(left, top, plotWidth, plotHeight);
    cr.clip();
    for (const [key, color, direction] of [
        ['tx', UPLOAD_COLOR, -1], ['rx', DOWNLOAD_COLOR, 1],
    ]) {
        cr.setSourceRGBA(...color, 1);
        const slot = plotWidth / BAR_COUNT;
        const gap = compact ? 1 : 3;
        for (let i = 0; i < BAR_COUNT; i++) {
            const size = amplitude * bars[i][key] / scale;
            if (size <= 0)
                continue;
            cr.rectangle(left + i * slot + gap / 2,
                direction < 0 ? center - size : center,
                Math.max(1, slot - gap), size);
            cr.fill();
        }
    }
}

// Higher resolution live view, independent of the panel's ten-bar averages.
export function liveChartData(history, now, wallNow, count = 60) {
    const start = now - HISTORY_SECONDS;
    const step = HISTORY_SECONDS / count;
    const points = Array.from({length: count}, (_, i) => ({
        time: wallNow - HISTORY_SECONDS + i * step,
        end: wallNow - HISTORY_SECONDS + (i + 1) * step,
        rx: 0, tx: 0, duration: 0, configs: [],
    }));
    let rx = 0;
    let tx = 0;
    for (let i = 1; i < history.length; i++) {
        const previous = history[i - 1];
        const point = history[i];
        if (point.time <= previous.time || point.time - previous.time >= 10 || point.gap)
            continue;
        for (let j = 0; j < count; j++) {
            const from = start + j * step;
            const overlap = Math.max(0, Math.min(point.time, from + step) - Math.max(previous.time, from));
            points[j].rx += point.rx * overlap;
            points[j].tx += point.tx * overlap;
            points[j].duration += overlap;
            rx += point.rx * overlap;
            tx += point.tx * overlap;
        }
    }
    for (const point of points) {
        if (point.duration) {
            point.rx /= point.duration;
            point.tx /= point.duration;
        }
    }
    return {start: wallNow - HISTORY_SECONDS, end: wallNow, points, rx, tx};
}

export function areaScale(points) {
    const peak = points.reduce((max, point) => Math.max(max, point.rx, point.tx), 1000);
    const power = 10 ** Math.floor(Math.log10(peak));
    return [1, 2, 5, 10].find(step => step * power >= peak) * power;
}

export function pointAtX(x, width, count) {
    return Math.max(0, Math.min(count - 1, Math.floor((x - 0.5) / Math.max(1, width - 1) * count)));
}

function roundedRect(cr, x, y, width, height, radius) {
    const r = Math.max(0, Math.min(radius, width / 2, height / 2));
    cr.newSubPath();
    cr.arc(x + width - r, y + r, r, -Math.PI / 2, 0);
    cr.arc(x + width - r, y + height - r, r, 0, Math.PI / 2);
    cr.arc(x + r, y + height - r, r, Math.PI / 2, Math.PI);
    cr.arc(x + r, y + r, r, Math.PI, 3 * Math.PI / 2);
    cr.closePath();
}

// Fritsch–Carlson tangents: smooth curves that never overshoot the samples,
// so a mirrored series can never cross the center line.
function monotoneTangents(ys, step) {
    const n = ys.length;
    const slopes = Array.from({length: Math.max(0, n - 1)}, (_, i) => (ys[i + 1] - ys[i]) / step);
    const tangents = ys.map((_, i) => {
        if (i === 0) return slopes[0] ?? 0;
        if (i === n - 1) return slopes[n - 2];
        return slopes[i - 1] * slopes[i] <= 0 ? 0 : (slopes[i - 1] + slopes[i]) / 2;
    });
    for (let i = 0; i < n - 1; i++) {
        if (!slopes[i]) {
            tangents[i] = tangents[i + 1] = 0;
            continue;
        }
        const a = tangents[i] / slopes[i];
        const b = tangents[i + 1] / slopes[i];
        const length = a * a + b * b;
        if (length > 9) {
            const t = 3 / Math.sqrt(length);
            tangents[i] = t * a * slopes[i];
            tangents[i + 1] = t * b * slopes[i];
        }
    }
    return tangents;
}

function traceCurve(cr, xs, ys, step) {
    const tangents = monotoneTangents(ys, step);
    for (let i = 0; i < xs.length - 1; i++) {
        const h = (xs[i + 1] - xs[i]) / 3;
        cr.curveTo(xs[i] + h, ys[i] + tangents[i] * h,
            xs[i + 1] - h, ys[i + 1] - tangents[i + 1] * h, xs[i + 1], ys[i + 1]);
    }
}

const SERIES = [['tx', UPLOAD_COLOR, -1], ['rx', DOWNLOAD_COLOR, 1]];

export function drawAreaChart(cr, width, height, points, selected = -1) {
    if (width <= 4 || height <= 4 || !points.length)
        return;
    const left = 0.5;
    const top = 0.5;
    const plotWidth = width - 1;
    const plotHeight = height - 1;
    const center = Math.round(height / 2) + 0.5;
    const amplitude = plotHeight / 2 - 4;
    const scale = areaScale(points);
    const slot = plotWidth / points.length;
    cr.save();
    roundedRect(cr, left, top, plotWidth, plotHeight, 8);
    cr.setSourceRGBA(0.5, 0.5, 0.5, 0.06);
    cr.fillPreserve();
    cr.setSourceRGBA(0.5, 0.5, 0.5, 0.2);
    cr.setLineWidth(1);
    cr.stroke();
    roundedRect(cr, left, top, plotWidth, plotHeight, 8);
    cr.clip();

    // Quiet dashed guides at half and full scale, and at each quarter of time.
    cr.setDash([2, 4], 0);
    cr.setSourceRGBA(0.5, 0.5, 0.5, 0.22);
    for (const fraction of [-1, -0.5, 0.5, 1]) {
        const y = Math.round(center + fraction * amplitude) + 0.5;
        cr.moveTo(left, y);
        cr.lineTo(left + plotWidth, y);
    }
    for (let i = 1; i < 4; i++) {
        const x = Math.round(left + plotWidth * i / 4) + 0.5;
        cr.moveTo(x, top);
        cr.lineTo(x, top + plotHeight);
    }
    cr.stroke();
    cr.setDash([], 0);

    if (selected >= 0 && selected < points.length) {
        cr.setSourceRGBA(0.5, 0.5, 0.5, 0.12);
        cr.rectangle(left + selected * slot, top, Math.max(1, slot), plotHeight);
        cr.fill();
    }

    const y = (key, i, direction) => center + direction * amplitude * points[i][key] / scale;
    for (const [key, color, direction] of SERIES) {
        for (let from = 0; from < points.length;) {
            if (!points[from].duration) {
                from++;
                continue;
            }
            let to = from + 1;
            while (to < points.length && points[to].duration)
                to++;
            const xs = [left + from * slot];
            const ys = [y(key, from, direction)];
            for (let i = from; i < to; i++) {
                xs.push(left + (i + 0.5) * slot);
                ys.push(y(key, i, direction));
            }
            xs.push(left + to * slot);
            ys.push(y(key, to - 1, direction));

            const peak = direction < 0 ? Math.min(...ys) : Math.max(...ys);
            const gradient = new Cairo.LinearGradient(0, peak, 0, center);
            gradient.addColorStopRGBA(0, ...color, 0.4);
            gradient.addColorStopRGBA(1, ...color, 0.06);
            cr.moveTo(xs[0], center);
            cr.lineTo(xs[0], ys[0]);
            traceCurve(cr, xs, ys, slot);
            cr.lineTo(xs.at(-1), center);
            cr.closePath();
            cr.setSource(gradient);
            cr.fill();

            cr.moveTo(xs[0], ys[0]);
            traceCurve(cr, xs, ys, slot);
            cr.setSourceRGBA(...color, 1);
            cr.setLineWidth(1.6);
            cr.setLineJoin(Cairo.LineJoin.ROUND);
            cr.setLineCap(Cairo.LineCap.ROUND);
            cr.stroke();
            from = to;
        }
    }

    cr.setSourceRGBA(0.5, 0.5, 0.5, 0.55);
    cr.setLineWidth(1);
    cr.moveTo(left, center);
    cr.lineTo(left + plotWidth, center);
    cr.stroke();

    if (selected >= 0 && selected < points.length) {
        const x = Math.round(left + (selected + 0.5) * slot) + 0.5;
        cr.setSourceRGBA(0.5, 0.5, 0.5, 0.7);
        cr.setLineWidth(1);
        cr.setDash([3, 3], 0);
        cr.moveTo(x, top);
        cr.lineTo(x, top + plotHeight);
        cr.stroke();
        cr.setDash([], 0);
        if (points[selected].duration) {
            for (const [key, color, direction] of SERIES) {
                const markerY = y(key, selected, direction);
                cr.setSourceRGBA(...color, 0.25);
                cr.arc(x, markerY, 6.5, 0, 2 * Math.PI);
                cr.fill();
                cr.setSourceRGBA(...color, 1);
                cr.arc(x, markerY, 3.5, 0, 2 * Math.PI);
                cr.fill();
            }
        }
    }
    cr.restore();
}
