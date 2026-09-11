// Truth-value stats assembly (spec/04, T01).
//
// Stat(L) = Init × Growth[L][growthTableID]   -- the original's own formula,
// verified against ゆの's full curve (Lv1 345/220/170/111 → Lv80 1980/915/1244/119.8).
// hp/atk/mgc/def/mdef/luck round to int; spd keeps one decimal because it is
// used as a ratio (±10% of the class baseline), not a raw number.
//
// Enemies interpolate linearly between their Init (at initLv) and Max
// (at maxLv) rows -- the floor number picks the point on the curve; the
// endpoint values themselves are copied verbatim from QuestEnemyList.
//
// No TEMPO here: this file returns truth values only. combat.js applies the
// single tuning constant on top (spec/04 §6).
//
// Pure data functions -- no three, no DOM, so node harnesses can drive it.

// The original computes stats in Unity, whose Mathf.Round is banker's rounding
// (0.5 -> nearest even), not half-up. Values land on .5 often enough (growth
// multipliers are 3-decimal) that the difference is visible, so match Unity.
function roundLikeUnity(value) {
    const floor = Math.floor(value);
    const diff = value - floor;
    if (diff < 0.5) {
        return floor;
    }
    if (diff > 0.5) {
        return floor + 1;
    }
    return floor % 2 === 0 ? floor : floor + 1;
}

function round1(value) {
    return roundLikeUnity(value * 10) / 10;
}

export function createStats(tables) {
    const cardsById = new Map();
    (tables.cards || []).forEach(function (card) {
        cardsById.set(card.id, card);
    });
    const growthByLv = new Map();
    (tables.growth || []).forEach(function (row) {
        growthByLv.set(row.lv, row);
    });
    const enemiesById = new Map();
    (tables.enemies || []).forEach(function (enemy) {
        enemiesById.set(enemy.id, enemy);
    });
    let byResource = null;      // resourceId -> card, built on first ask

    const GROWTH_KEYS = { hp: "hp", atk: "atk", mgc: "mgc", def: "def",
                          mdef: "mdef", spd: "spd", luck: "luck" };

    function statsFor(charaId, level) {
        const card = cardsById.get(charaId);
        if (!card) {
            return null;
        }
        const lv = Math.round(Math.min(100, Math.max(1, level)));
        const growth = growthByLv.get(lv);
        if (!growth) {
            return null;
        }
        const gt = Math.min(4, Math.max(0, card.growthTableID));
        const out = {};
        Object.keys(GROWTH_KEYS).forEach(function (key) {
            const value = card.init[key] * growth[key][gt];
            out[key] = key === "spd" ? round1(value) : roundLikeUnity(value);
        });
        return out;
    }

    function enemyStats(enemyId, level) {
        const enemy = enemiesById.get(enemyId);
        if (!enemy) {
            return null;
        }
        const lv = Math.min(enemy.maxLv, Math.max(enemy.initLv, level));
        const span = enemy.maxLv - enemy.initLv;
        const t = span > 0 ? (lv - enemy.initLv) / span : 0;
        const out = {};
        Object.keys(enemy.init).forEach(function (key) {
            const value = enemy.init[key] + (enemy.max[key] - enemy.init[key]) * t;
            out[key] = key === "spd" ? round1(value) : roundLikeUnity(value);
        });
        out.element = enemy.element;
        return out;
    }

    return {
        statsFor: statsFor,
        enemyStats: enemyStats,
        card: function (charaId) { return cardsById.get(charaId) || null; },
        // The roster UI walks the whole card table (it filters element and
        // reads init stats), so it needs the rows, not just lookups.
        all: function () { return Array.from(cardsById.values()); },
        // The browser knows a character by the resourceId it renders with
        // (core/cards.js), not by the CharacterList id this table is keyed on,
        // so the driver needs the crosswalk. Built lazily: the node harnesses
        // never ask for it and it walks 1281 rows.
        cardByResource: function (resourceId) {
            if (!byResource) {
                byResource = new Map();
                cardsById.forEach(function (card) {
                    if (!byResource.has(card.resourceId)) {
                        byResource.set(card.resourceId, card);
                    }
                });
            }
            return byResource.get(resourceId) || null;
        },
        enemy: function (enemyId) { return enemiesById.get(enemyId) || null; }
    };
}

// Browser loader: the shipped tables sit next to this file; fetch them once at
// boot. Node harnesses read the files themselves and call createStats directly.
export function loadStats(fetchFn) {
    const fetcher = fetchFn || (typeof fetch === "function" ? fetch : null);
    if (!fetcher) {
        return Promise.reject(new Error("no fetch available"));
    }
    const base = new URL(".", import.meta.url);
    return Promise.all([
        fetcher(new URL("cards-rl.json", base)),
        fetcher(new URL("growth.json", base)),
        fetcher(new URL("enemies.json", base))
    ]).then(function (responses) {
        return Promise.all(responses.map(function (r) {
            if (!r.ok) { throw new Error("table fetch failed: " + r.status); }
            return r.json();
        }));
    }).then(function (tables) {
        return createStats({ cards: tables[0].cards, growth: tables[1], enemies: tables[2].enemies });
    });
}
