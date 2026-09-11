// Seeded RNG for the roguelike layer (T05 contract).
//
//   createRandom(seed) → () => [0, 1)
//   seedFrom(str)      → same, but seeds from a string
//   hash32(str)        → uint32 fingerprint of a string
//
// Determinism is the whole point: dungeon layouts, loot rolls and AI decisions
// must reproduce bit-for-bit from the same seed, on every browser. So both
// functions stick to integer ops (imul, >>>) and avoid anything that touches
// floating-point nondeterminism beyond the final division.
//
// hash32 is xmur3 and the generator is mulberry32 — small, well-understood,
// and good enough for gameplay (this is not cryptography).

export function hash32(str) {
    const text = String(str);
    let h = 1779033703 ^ text.length;
    for (let i = 0; i < text.length; i++) {
        h = Math.imul(h ^ text.charCodeAt(i), 3432918353);
        h = (h << 13) | (h >>> 19);
    }
    h = Math.imul(h ^ (h >>> 16), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    h ^= h >>> 16;
    return h >>> 0;
}

export function createRandom(seed) {
    let a = seed >>> 0;
    return function () {
        a = (a + 0x6D2B79F5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

export function seedFrom(text) {
    return createRandom(hash32(text));
}
