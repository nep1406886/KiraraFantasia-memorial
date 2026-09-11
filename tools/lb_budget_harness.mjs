// Price every room core/lbroom.js can compose, against the §6.1.3 ceiling.
//
// Run by tools/check_lb_budget.py, which copies core/*.js to .mjs first (node
// reads a bare .js as CommonJS) and hands the copies' paths in argv.
//
// Why this prices the composer rather than a list of rooms: the maze is dug at
// runtime from a seed, so there is no room JSON to scan the way
// tools/check_mv_budget.py scans asset/mv/*.json. The only thing that exists
// ahead of time is the function that decides what stands in a room -- so that
// is what gets priced, over every volume, room kind, room id, and many seeds.
//
// usage: node lb_budget_harness.mjs <lbroom.mjs> <lbcost.mjs> <volumes.mjs>
//                                   <platformer.mjs> <lbfight.mjs>

const [roomPath, costPath, volumesPath, platformerPath, fightPath] =
    process.argv.slice(2);

const { compose, attachIds } = await import(pathToUrl(roomPath));
const cost = await import(pathToUrl(costPath));
const { VOLUMES, drawTiers } = await import(pathToUrl(volumesPath));
const { createRandom, seedFrom } = await import(pathToUrl(platformerPath));
const { createFight, ENEMY_TIERS } = await import(pathToUrl(fightPath));

function pathToUrl(p) {
    return "file:///" + p.replace(/\\/g, "/");
}

function roomSeed(seed, roomId) {
    return seedFrom(String(seed) + ":" + "room:" + roomId);
}

// How many run seeds to sweep per volume. drawTiers is random, so a single
// seed does not see the tail of the count distribution -- and the tail is
// exactly where the ceiling is crossed (9 adepts, not 6).
const SEEDS = 60;
const ROOM_IDS = 14;   // lbmaze ROOMS_MAX

const out = {
    limit: cost.DRAW_LIMIT,
    staticDraws: cost.STATIC_DRAWS,
    worstHero: cost.WORST_HERO_DRAWS,
    heroDraws: cost.HERO_DRAWS,
    // Per-tier worst model, so the report says which model set the ceiling.
    worstTier: cost.WORST_TIER_DRAWS,
    rooms: 0,
    // The worst room the composer will actually build.
    worst: null,
    // The worst room the *unclamped* pipeline would have built. Kept in the
    // report so the gate can assert the clamp is load-bearing: if this ever
    // equals `worst`, the trim is dead code and the volumes table changed
    // under it.
    worstRaw: null,
    overLimit: [],
    trimmedRooms: 0,
    bodiesBefore: 0,
    bodiesAfter: 0,
    // Same room composed twice must be identical (§5.2: no Math.random()).
    unstable: [],
    // A body whose model does not match its tier -- attachIds pairing drift.
    tierMismatch: [],
    // Bodies actually placed in the room by createFight, vs specs handed to
    // the renderer. A mismatch means some body has no model or a wrong one.
    idMismatch: [],
    // The enemy half of the worst room's bill, with the hero and the static
    // set taken back out.
    //
    // Reported separately because `worst.draws` is priced against whichever
    // hero figure compose() chose, so the gate cannot check the ceiling for a
    // *different* hero from that number alone. If compose() ever prices the
    // lightest hero, its rooms still come in under the limit by its own
    // arithmetic -- and only fail once Lamp (48) walks into them. Handing the
    // enemy draws over on their own lets the gate redo the sum against the
    // heaviest hero itself.
    worstEnemyDraws: 0
};

const tierNames = Object.keys(ENEMY_TIERS);

for (const vol of VOLUMES) {
    for (const kind of ["fight", "boss"]) {
        for (let runNumber = 1; runNumber <= SEEDS; runNumber++) {
            const seed = seedFrom(String(runNumber) + ":" + String(vol.id));
            for (let roomId = 0; roomId < ROOM_IDS; roomId++) {
                out.rooms += 1;
                const rs = roomSeed(seed, roomId);

                // (a) unclamped: drawTiers straight into modelFor.
                let rawDraws = cost.STATIC_DRAWS + cost.WORST_HERO_DRAWS;
                let rawBodies = 0;
                for (const g of drawTiers(vol, kind, createRandom(rs))) {
                    const model = cost.modelFor(g.tier, vol.id, roomId);
                    rawDraws += (cost.MODEL_COSTS[model] || 0) * g.count;
                    rawBodies += g.count;
                }
                out.bodiesBefore += rawBodies;
                if (!out.worstRaw || rawDraws > out.worstRaw.draws) {
                    out.worstRaw = { draws: rawDraws, volume: vol.id, kind,
                                     roomId };
                }

                // (b) what the game builds.
                const built = compose(vol, kind, roomId, createRandom(rs));
                out.bodiesAfter += built.enemies.length;
                if (built.trimmed > 0) { out.trimmedRooms += 1; }

                // Priced from the specs, not read off built.draws, so the
                // figure does not carry compose()'s choice of hero.
                const enemyDraws = built.specs.reduce(function (a, s) {
                    return a + (cost.MODEL_COSTS[s.model] || 0);
                }, 0);
                if (enemyDraws > out.worstEnemyDraws) {
                    out.worstEnemyDraws = enemyDraws;
                }

                const where = { volume: vol.id, kind, roomId,
                                seed: runNumber,
                                groups: built.groups.map(function (g) {
                                    return g.count + "x" + g.tier;
                                }),
                                draws: built.draws,
                                enemyDraws,
                                trimmed: built.trimmed };

                if (!out.worst || built.draws > out.worst.draws) {
                    out.worst = where;
                }
                if (built.draws > cost.DRAW_LIMIT && out.overLimit.length < 20) {
                    out.overLimit.push(where);
                }

                // Determinism: compose twice from the same seed.
                const again = compose(vol, kind, roomId, createRandom(rs));
                if (again.draws !== built.draws
                    || again.enemies.length !== built.enemies.length) {
                    if (out.unstable.length < 20) { out.unstable.push(where); }
                }

                // Every spec's model must belong to its own tier's list.
                for (const s of built.specs) {
                    const list = cost.ENEMY_MODELS[s.kind] || [];
                    if (!list.some(function (m) { return m.id === s.model; })) {
                        if (out.tierMismatch.length < 20) {
                            out.tierMismatch.push({ volume: vol.id, kind,
                                roomId, tier: s.kind, model: s.model });
                        }
                    }
                }

                // attachIds must cover every body the fight actually placed.
                if (built.enemies.length) {
                    const fightState = createFight(
                        { hp: 100, ink: 30, breath: 3,
                          stats: { inkRegen: 1, breathRegen: 1, speed: 5,
                                   attack: 8, dodge: 0, crit: 0, critPower: 1,
                                   rate: 1, shotSpeed: 8, range: 8,
                                   defense: 1 } },
                        built.enemies, rs);
                    const specs = attachIds(built.specs, fightState.enemies);
                    const missing = specs.filter(function (s) {
                        return !s.model;
                    });
                    // Compare the model against the *body's* tier, not against
                    // the returned kind.
                    //
                    // attachIds sets `kind: e.kind || spec.kind`, so reading
                    // s.kind back and comparing it to e.kind asks the body
                    // about itself and can never fail. That is the exact drift
                    // this is here to catch: pair body i with spec j and every
                    // body still reports its own correct kind while wearing
                    // another tier's model -- a boss standing in the swarm.
                    const wrongTier = specs.filter(function (s, i) {
                        const list = cost.ENEMY_MODELS[
                            fightState.enemies[i].kind] || [];
                        return !list.some(function (m) {
                            return m.id === s.model;
                        });
                    });
                    if ((specs.length !== fightState.enemies.length
                         || missing.length || wrongTier.length)
                        && out.idMismatch.length < 20) {
                        out.idMismatch.push({
                            volume: vol.id, kind, roomId,
                            specs: specs.length,
                            bodies: fightState.enemies.length,
                            missing: missing.length,
                            wrongTier: wrongTier.length
                        });
                    }
                }
            }
        }
    }
}

// The per-tier ceiling, reported so a model swap that breaks the §4.3 ordering
// (swarm cheaper than adept cheaper than boss) is visible.
out.tierOrdering = tierNames.map(function (t) {
    return { tier: t, worst: cost.WORST_TIER_DRAWS[t] };
});

process.stdout.write(JSON.stringify(out));
