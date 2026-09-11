// Measure core/lbmaze.js over many volumes and print JSON.
//
// Takes the module path as argv[2] like tools/lb_stat_harness.mjs, because the
// negative cases hand over a patched *copy*. A fixed import path could not be
// broken on purpose, and a check whose negatives cannot break it is not a check.

import { pathToFileURL } from "node:url";

const modulePath = process.argv[2];
if (!modulePath) {
    console.error("usage: lb_maze_harness.mjs <path to lbmaze module>");
    process.exit(2);
}
const maze = await import(pathToFileURL(modulePath).href);

const RUNS = 500;
const VOLUME = "kinmosa";

const out = {};
out.grid = maze.GRID;
out.roomsMin = maze.ROOMS_MIN;
out.roomsMax = maze.ROOMS_MAX;
out.spineRatio = maze.SPINE_RATIO;
out.runs = RUNS;

const deadEndHist = {};
const kindTotals = {};
const roomCounts = {};
let disconnected = 0;
let brokenLinks = 0;
let corridors = 0;
let outOfRange = 0;
let bossNotFarthest = 0;
let startNotZero = 0;
const distances = [];

for (let run = 0; run < RUNS; run++) {
    const seed = maze.runSeed(run, VOLUME);
    const v = maze.bindVolume(seed, VOLUME);

    roomCounts[v.rooms.length] = (roomCounts[v.rooms.length] || 0) + 1;
    if (v.rooms.length < maze.ROOMS_MIN || v.rooms.length > maze.ROOMS_MAX) {
        outOfRange += 1;
    }
    if (!maze.isConnected(v)) { disconnected += 1; }
    brokenLinks += maze.linksAreMutual(v).length;

    const de = maze.deadEnds(v.rooms).length;
    deadEndHist[de] = (deadEndHist[de] || 0) + 1;
    if (de <= 2) { corridors += 1; }

    // The boss must sit at the greatest distance from the start.
    const dist = maze.distances(v.rooms, v.startId);
    let far = 0;
    v.rooms.forEach(function (r) { if (dist[r.id] > far) { far = dist[r.id]; } });
    if (dist[v.bossId] !== far) { bossNotFarthest += 1; }
    if (v.startId !== 0) { startNotZero += 1; }
    distances.push(far);

    v.rooms.forEach(function (r) {
        kindTotals[r.kind] = (kindTotals[r.kind] || 0) + 1;
    });
}

out.roomCounts = roomCounts;
out.outOfRange = outOfRange;
out.disconnected = disconnected;
out.brokenLinks = brokenLinks;
out.deadEnds = deadEndHist;
out.corridors = corridors;
out.corridorRate = corridors / RUNS;
out.kindTotals = kindTotals;
out.bossNotFarthest = bossNotFarthest;
out.startNotZero = startNotZero;
out.maxDistanceMin = Math.min.apply(null, distances);
out.maxDistanceMax = Math.max.apply(null, distances);

// Every volume must contain exactly one start and one boss, and at least one
// of each of the other kinds -- a volume with no shop or no cache silently
// removes a mechanic for that run.
let missingKind = 0;
let multipleBoss = 0;
for (let run = 0; run < RUNS; run++) {
    const v = maze.bindVolume(maze.runSeed(run, VOLUME), VOLUME);
    const counts = {};
    v.rooms.forEach(function (r) { counts[r.kind] = (counts[r.kind] || 0) + 1; });
    if (counts.boss !== 1 || counts.start !== 1) { multipleBoss += 1; }
    ["fight", "puzzle", "shop", "cache"].forEach(function (k) {
        if (!counts[k]) { missingKind += 1; }
    });
}
out.missingKind = missingKind;
out.multipleBoss = multipleBoss;

// Same seed twice -> identical. Different seed -> different *shape*.
//
// shapeOf() strips volumeId and seed before comparing. Comparing the whole
// object was a weak check: the returned object carries `seed`, so two volumes
// differ in JSON even when the maze is byte-identical. A negative case that
// pinned the generator to a constant seed still "passed" because the metadata
// moved -- the check was reading the label, not the thing.
function shapeOf(v) {
    return JSON.stringify({
        bossId: v.bossId,
        startId: v.startId,
        rooms: v.rooms.map(function (r) {
            return { id: r.id, x: r.x, y: r.y, kind: r.kind, links: r.links };
        })
    });
}

const a = shapeOf(maze.bindVolume(maze.runSeed(7, "gochiusa"), "gochiusa"));
const b = shapeOf(maze.bindVolume(maze.runSeed(7, "gochiusa"), "gochiusa"));
const c = shapeOf(maze.bindVolume(maze.runSeed(8, "gochiusa"), "gochiusa"));
out.deterministic = a === b;
out.seedMatters = a !== c;

// Branch seeds must differ from each other, or re-rolling loot would reshape
// the maze (§5.2).
const seed = maze.runSeed(3, "kinmosa");
out.branchSeeds = {
    maze: maze.branchSeed(seed, "maze"),
    room0: maze.roomSeed(seed, 0),
    room1: maze.roomSeed(seed, 1),
    loot0: maze.lootSeed(seed, 0)
};
out.branchSeedsDistinct =
    new Set(Object.values(out.branchSeeds)).size === 4;

out.quotas13 = maze.quotas(13);

console.log(JSON.stringify(out, null, 1));
