import Cairo from 'cairo';
import {addSample, chartBars, chartScale, drawChart, liveChartData, areaScale, drawAreaChart, pointAtX} from '../chart.js';

function near(actual, expected, message) {
    if (Math.abs(actual - expected) > 0.00001)
        throw new Error(`${message}: ${actual} != ${expected}`);
}
const history = [];
for (let time = 0; time <= 120; time++)
    addSample(history, time, time * 100, time * 50);
if (history.length !== 61 || history[0].time !== 60)
    throw new Error('History must retain the most recent minute with an interval boundary');
near(chartScale(history), 11750, 'Scale uses six-second averages');
near(chartScale([]), 1000, 'Idle scale floor');
const constant = [];
for (let time = 0; time <= 60; time += 2)
    addSample(constant, time, 600, 300);
const bars = chartBars(constant, 60);
if (bars.length !== 10)
    throw new Error('Exactly ten bars required');
for (const bar of bars) {
    near(bar.rx, 600, 'Six seconds of constant download');
    near(bar.tx, 300, 'Six seconds of constant upload');
}
const irregular = chartBars([
    {time: 0, rx: 0, tx: 0},
    {time: 2, rx: 300, tx: 600},
    {time: 6, rx: 900, tx: 0},
], 6);
near(irregular[9].rx, 700, 'Irregular samples weighted by elapsed time');
near(irregular[9].tx, 200, 'Upload weighted independently');
near(irregular[8].rx, 0, 'Empty history stays empty');
addSample(history, 300, 0, 0);
if (history.length !== 2 || chartBars(history, 300).some(bar => bar.rx || bar.tx))
    throw new Error('Long gaps must not create traffic');

for (const compact of [false, true]) {
    const width = compact ? 64 : 300;
    const height = compact ? 24 : 100;
    const rectangles = [];
    const mock = {
        setSourceRGBA() {}, fill() {}, setLineWidth() {},
        moveTo() {}, lineTo() {}, stroke() {}, clip() {},
        rectangle(x, y, w, h) { rectangles.push({x, y, w, h}); },
    };
    drawChart(mock, width, height, constant, 60, compact);
    const traffic = rectangles.slice(2);
    if (traffic.length !== 20)
        throw new Error('Ten mirrored upload/download bar pairs required');
    for (let i = 0; i < 10; i++) {
        if (traffic[i].y >= height / 2 || traffic[i + 10].y !== height / 2)
            throw new Error('Upload above center, download below');
        near(traffic[i].x, traffic[i + 10].x, 'Mirrored bars aligned');
    }
    const surface = new Cairo.ImageSurface(Cairo.Format.ARGB32, width, height);
    const cr = new Cairo.Context(surface);
    for (const samples of [[], history, constant]) {
        cr.save();
        drawChart(cr, width, height, samples, samples.at(-1)?.time ?? 0, compact);
        cr.restore();
    }
    surface.writeToPNG(compact ? '/tmp/topbar-network-mini.png' : '/tmp/topbar-network-chart.png');
    cr.$dispose();
}
print('Ten-bar averaging, timing, scaling, geometry, and Cairo checks passed');

const live = liveChartData(constant, 60, 1000);
near(live.rx, 36000, 'Live range received bytes');
near(live.tx, 18000, 'Live range sent bytes');
near(live.points[0].rx, 600, 'Live one-second detail');
near(live.points[0].time, 940, 'Live chart uses wall-clock timestamps');
near(live.points[59].end, 1000, 'Latest live bucket ends now');
const stale = liveChartData(constant, 120, 1060);
if (stale.points.some(point => point.duration))
    throw new Error('Stale data cannot extend into unobserved time');
const disconnected = liveChartData([{time: 0, rx: 0, tx: 0},
    {time: 20, rx: 100, tx: 100}], 20, 1000);
if (disconnected.points.some(point => point.duration))
    throw new Error('Long gaps cannot draw a connecting area');
const readFailure = liveChartData([{time: 0, rx: 0, tx: 0},
    {time: 2, rx: 0, tx: 0, gap: true}], 2, 1000);
if (readFailure.points.some(point => point.duration))
    throw new Error('A failed read is a gap, not observed idle traffic');
near(areaScale([{rx: 12345, tx: 999, duration: 1}]), 20000, 'Readable rounded scale');
near(pointAtX(-50, 360, 60), 0, 'Hover clamps left');
near(pointAtX(500, 360, 60), 59, 'Hover clamps right');
const detailed = liveChartData(Array.from({length: 61}, (_, i) => ({
    time: i, rx: 120000 + Math.sin(i / 4) * 100000,
    tx: 50000 + Math.cos(i / 5) * 40000,
})), 60, 1000);
// Missing observations split the area into independent polygons.
detailed.points[25].duration = 0;
detailed.points[26].duration = 0;
for (const [width, height] of [[360, 160], [720, 320], [1, 1]]) {
    const surface = new Cairo.ImageSurface(Cairo.Format.ARGB32, width, height);
    const cr = new Cairo.Context(surface);
    drawAreaChart(cr, width, height, detailed.points, 40);
    drawAreaChart(cr, width, height, [], -1);
    surface.writeToPNG(`/tmp/topbar-network-area-${width}.png`);
    cr.$dispose();
}
print('Area chart timing, gaps, rates, hover selection, scale and Cairo rendering passed');
