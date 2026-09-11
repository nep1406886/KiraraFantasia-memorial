// Fixed-capacity object pool for the roguelike logic layer.
//
// No three.js, no DOM. Bullets are the reason this exists: a boss spiral can
// ask for hundreds of objects a second, and the GC pause from allocating them
// is exactly the kind of hitch a dodge-timing game cannot afford. So every
// object is allocated once, up front, and reused forever.
//
// The pool is *dense*: slots [0, activeCount) are live, the rest are free.
// release() swaps the released object with the last live one, which keeps the
// live range contiguous (fast iteration) at the cost of unstable ordering --
// bullets do not care about order.

export function createPool(capacity, factory) {
    const slots = new Array(capacity);
    for (let i = 0; i < capacity; i++) {
        const obj = factory(i);
        obj._slot = i;
        obj.alive = false;
        slots[i] = obj;
    }
    let activeCount = 0;

    const pool = {
        capacity: capacity,

        get active() { return activeCount; },
        get free() { return capacity - activeCount; },

        // Returns a dead object from the free range, or null when full. The
        // caller initialises the fields it cares about; stale values from the
        // previous life are the caller's problem to overwrite (bullets set all
        // of theirs in emit()).
        acquire: function () {
            if (activeCount >= capacity) {
                return null;
            }
            const obj = slots[activeCount];
            obj.alive = true;
            activeCount += 1;
            return obj;
        },

        release: function (obj) {
            if (!obj.alive) {
                return false;
            }
            const i = obj._slot;
            const last = activeCount - 1;
            const other = slots[last];
            slots[i] = other;
            other._slot = i;
            slots[last] = obj;
            obj._slot = last;
            obj.alive = false;
            activeCount = last;
            return true;
        },

        // Iterates the live range *backwards* so a callback may release the
        // object it is looking at (the swap moves an unvisited object into the
        // slot being vacated, which a forward loop would skip).
        forEach: function (fn) {
            for (let i = activeCount - 1; i >= 0; i--) {
                fn(slots[i], i);
            }
        },

        // Iterates in slot order without allowing releases -- for views, which
        // want a stable-ish walk and never mutate.
        forEachStable: function (fn) {
            for (let i = 0; i < activeCount; i++) {
                fn(slots[i], i);
            }
        },

        clear: function () {
            for (let i = 0; i < activeCount; i++) {
                slots[i].alive = false;
            }
            activeCount = 0;
        },

        // Debug/harness only: the backing array, live range first.
        get slots() { return slots; }
    };
    return pool;
}
