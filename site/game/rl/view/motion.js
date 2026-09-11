// Read-only render snapshots. Physics owns units; interpolation never writes them.
// One snapshot is taken BEFORE each fixed update, including catch-up steps.
export function createMotionSampler() {
    const samples = new WeakMap();
    let roomId = null;
    let dungeon = null;
    let world = null;

    function capture(unit) {
        if (!unit) { return; }
        let sample = samples.get(unit);
        if (!sample) {
            sample = { position: { x: unit.x, y: unit.y } };
            samples.set(unit, sample);
        }
        sample.x = unit.x;
        sample.y = unit.y;
        sample.spawnId = unit.spawnId;
    }

    return {
        beginStep: function (nextWorld) {
            world = nextWorld;
            roomId = world.roomId;
            dungeon = world.dungeon;
            capture(world.player);
            world.enemies.forEach(capture);
            if (world.danmaku) { world.danmaku.forEach(capture); }
        },
        position: function (unit, alpha) {
            const sample = samples.get(unit);
            if (!sample || !world || roomId !== world.roomId
                    || dungeon !== world.dungeon || sample.spawnId !== unit.spawnId) {
                return unit; // newly spawned/recycled entity or room teleport
            }
            const a = Math.max(0, Math.min(1, alpha === undefined ? 1 : alpha));
            sample.position.x = sample.x + (unit.x - sample.x) * a;
            sample.position.y = sample.y + (unit.y - sample.y) * a;
            return sample.position;
        }
    };
}
