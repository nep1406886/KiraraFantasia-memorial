// Fixed-step clock for the roguelike loop (master plan §4.3).
//
// The accumulator decouples simulation time from frame time: update() always
// runs with the same step (default 1/60) no matter how uneven the frames are,
// and render() gets the leftover as an interpolation alpha in [0,1).
//
// The 0.25s clamp is not optional: after a backgrounded tab stops running
// rAF, `now - last` can be tens of seconds, and without the clamp one frame
// would run thousands of steps ("the character is already dead when you come
// back"). At step = 1/60 the clamp caps a single frame at 15 steps.
//
// tick(dt) is deliberately separate from the rAF driver so a node harness can
// feed synthetic frame times without a DOM.

export const MAX_FRAME_DT = 0.25;
export const DEFAULT_STEP = 1 / 60;

export function createClock(options) {
    const config = options || {};
    const step = config.step || DEFAULT_STEP;
    const update = config.update || null;
    const render = config.render || null;

    let acc = 0;
    let running = false;
    let rafId = 0;
    let lastSeconds = null;

    // Advance by one frame's worth of time. Returns the number of update
    // steps that ran, so callers and harnesses can count without hooking
    // update().
    function tick(dt) {
        const frameDt = Number.isFinite(dt) ? Math.min(Math.max(dt, 0), MAX_FRAME_DT) : 0;
        acc += frameDt;
        let steps = 0;
        while (acc >= step) {
            if (update) {
                update(step, steps);
            }
            acc -= step;
            steps += 1;
        }
        if (render) {
            render(step > 0 ? acc / step : 0, steps, frameDt);
        }
        return steps;
    }

    function frame(now) {
        if (!running) {
            return;
        }
        const seconds = now / 1000;
        // First frame after start(): no elapsed time, just establish a base.
        const dt = lastSeconds === null ? 0 : seconds - lastSeconds;
        lastSeconds = seconds;
        tick(dt);
        rafId = requestAnimationFrame(frame);
    }

    function start() {
        if (running) {
            return;
        }
        running = true;
        lastSeconds = null;
        rafId = requestAnimationFrame(frame);
    }

    function stop() {
        running = false;
        cancelAnimationFrame(rafId);
    }

    return {
        tick: tick,
        start: start,
        stop: stop,
        get step() { return step; },
        get accumulator() { return acc; },
        get running() { return running; }
    };
}
