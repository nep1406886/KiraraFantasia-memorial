// Measure core/lbshop.js: stock composition, pricing, and -- the reason it
// exists -- whether a book's shops can absorb the scraps a book hands out.
//
// Run by tools/check_lb_shop.py, which copies core/*.js to .mjs first (node
// reads a bare .js as CommonJS) and hands the copies' paths in argv.
//
// usage: node lb_shop_harness.mjs <lbshop> <lbgear> <lbstat> <lbmaze> <platformer>

const [shopPath, gearPath, statPath, mazePath, platformerPath] =
    process.argv.slice(2);

const shop = await import(pathToUrl(shopPath));
const gear = await import(pathToUrl(gearPath));
const stat = await import(pathToUrl(statPath));
const maze = await import(pathToUrl(mazePath));
const { createRandom, seedFrom } = await import(pathToUrl(platformerPath));

function pathToUrl(p) {
    return "file:///" + p.replace(/\\/g, "/");
}

const out = {
    goods: shop.GOODS.map(function (g) { return g.id; }),
    stockSize: shop.STOCK,
    tierMax: gear.TIER_MAX,
    stock: [],
    pricing: [],
    refusals: [],
    heal: [],
    books: []
};

function vol(whiteness) {
    return { id: "v" + whiteness, whiteness, name: { ja: "", zh: "" } };
}

function fighterFor(level, effects) {
    const base = stat.baseStats({ classId: 0, elementId: 0, level });
    const s = stat.applyEffects(base, effects || []);
    return { stats: s, hp: s.hp, ink: s.ink, breath: s.breath };
}

// --- stock composition -------------------------------------------------------
//
// Swept over many rooms and many states of the player's gear, because the
// stock depends on what is worn: an empty slot should be favoured, and a
// fusable piece should always be offered.
for (let whiteness = 0; whiteness < 5; whiteness++) {
    const row = {
        whiteness,
        rooms: 0,
        sizes: {},
        kinds: {},
        tiers: {},
        // Shops that offered no way to restore HP.
        noHeal: 0,
        // Shops that offered a fusion while the player held a fusable piece.
        fusableHeld: 0,
        fusionOffered: 0,
        // Duplicate entries in one shop (two identical gear rows).
        dupRows: 0,
        // Gear rows landing on a slot the player has not filled.
        emptyHits: 0,
        gearRows: 0,
        priceMin: Infinity,
        priceMax: 0,
        // How often the unclamped roll would have exceeded the shelf's ceiling.
        // If this is 0 the clamp in shopTier is dead code, and the line that
        // says "never sell tier 5" is guarding nothing.
        wouldExceed: 0,
        rawRolls: 0
    };

    {
        const rrand = createRandom(seedFrom("raw:" + whiteness));
        for (let i = 0; i < 20000; i++) {
            row.rawRolls += 1;
            if (shop.rawShopTier(whiteness, rrand) > gear.TIER_MAX - 1) {
                row.wouldExceed += 1;
            }
        }
    }

    for (let k = 0; k < 4000; k++) {
        const rand = createRandom(seedFrom("stock:" + whiteness + ":" + k));
        // Build a plausible worn set: 0-4 pieces at mixed tiers.
        const worn = [];
        const nWorn = Math.floor(rand.next() * 5);
        const slots = gear.SLOT_IDS.slice();
        for (let i = 0; i < nWorn; i++) {
            const slot = slots.splice(Math.floor(rand.next() * slots.length), 1)[0];
            const list = gear.VARIANTS[slot];
            const v = list[Math.floor(rand.next() * list.length)];
            worn.push({ slot, variant: v.id,
                        tier: 1 + Math.floor(rand.next() * gear.TIER_MAX) });
        }
        const run = { scraps: 9999, gear: worn,
                      fighter: fighterFor(12) };
        const items = shop.stockFor(vol(whiteness), 100 + k, rand, run);

        row.rooms += 1;
        row.sizes[items.length] = (row.sizes[items.length] || 0) + 1;

        const heldFusable = worn.some(function (p) {
            return p.tier < gear.TIER_MAX;
        });
        if (heldFusable) { row.fusableHeld += 1; }

        const seen = {};
        items.forEach(function (it) {
            row.kinds[it.kind] = (row.kinds[it.kind] || 0) + 1;
            row.priceMin = Math.min(row.priceMin, it.price);
            row.priceMax = Math.max(row.priceMax, it.price);
            if (it.kind === "fuse" && heldFusable) { row.fusionOffered += 1; }
            if (it.kind !== "gear") { return; }
            row.gearRows += 1;
            row.tiers[it.piece.tier] = (row.tiers[it.piece.tier] || 0) + 1;
            const key = it.piece.slot + "/" + it.piece.variant + "/" + it.piece.tier;
            if (seen[key]) { row.dupRows += 1; }
            seen[key] = true;
            const filled = worn.some(function (p) { return p.slot === it.piece.slot; });
            if (!filled) { row.emptyHits += 1; }
        });
        if (!items.some(function (it) { return it.kind === "heal"; })) {
            row.noHeal += 1;
        }
    }
    if (row.priceMin === Infinity) { row.priceMin = 0; }
    out.stock.push(row);
}

// --- the price shown is the price charged ------------------------------------
//
// The trap this is here for: a fusion's cost lives in lbgear.fuseCost, and the
// shop adds a placement fee on top. If the row's `price` and what buy() takes
// out of run.scraps disagree, the player sees one number and loses another --
// and it only shows up as scraps quietly draining faster than the rows say.
for (let whiteness = 0; whiteness < 5; whiteness++) {
    for (let k = 0; k < 600; k++) {
        const rand = createRandom(seedFrom("price:" + whiteness + ":" + k));
        const worn = gear.SLOT_IDS.map(function (slot) {
            const list = gear.VARIANTS[slot];
            const v = list[Math.floor(rand.next() * list.length)];
            return { slot, variant: v.id,
                     tier: 1 + Math.floor(rand.next() * (gear.TIER_MAX - 1)) };
        });
        const f = fighterFor(12);
        f.hp = Math.max(1, Math.round(f.stats.hp * 0.4));
        const run = { scraps: 100000, gear: worn.slice(), fighter: f };
        const items = shop.stockFor(vol(whiteness), 200 + k, rand, run);
        items.forEach(function (it) {
            const before = run.scraps;
            const quoted = shop.canBuy(it, run);
            const res = shop.buy(it, run, rand);
            const took = before - run.scraps;
            out.pricing.push({
                whiteness, kind: it.kind,
                shown: it.price,
                quoted: quoted.ok ? (quoted.need | 0) : -1,
                took: took,
                ok: !!res.ok,
                // A sale must mark the row sold, or it can be bought twice.
                sold: !!it.sold
            });
        });
    }
}

// --- price by tier -----------------------------------------------------------
//
// A shelf that charges the same for a tier-1 and a tier-4 piece makes the tier
// on the label decorative, and the cheapest-first buyer above would strip the
// good rows first. Priced through priceOf so it reads the real table.
out.gearPrices = [];
for (let whiteness = 0; whiteness < 5; whiteness++) {
    const row = { whiteness, byTier: [] };
    for (let tier = 1; tier < gear.TIER_MAX; tier++) {
        row.byTier.push(shop.priceOf(
            { kind: "gear", piece: gear.makePiece("brush", "ho", tier) },
            whiteness));
    }
    // What it costs to *reach* tier n by fusing a tier-(n-1) piece already
    // worn. Indexed by the tier arrived at, so the gate can compare "buy tier
    // n" against "fuse up to tier n". Comparing it against a fusion *starting*
    // at tier n was the first version's mistake, and it reported the module
    // broken for every book while the module was right.
    row.fuseUpTo = [null, null];
    for (let tier = 1; tier < gear.TIER_MAX; tier++) {
        row.fuseUpTo.push(shop.priceOf({ kind: "fuse", slot: "brush",
                                         variant: "ho", tier: tier }, whiteness)
                          + gear.fuseCost(tier));
    }
    out.gearPrices.push(row);
}

// --- where the shop sits -----------------------------------------------------
//
// Measured off lbmaze layouts, because this is a placement property, not a
// pricing one: §5.1 puts shops at dead ends, and a third of the time the dead
// end was the one next to the entrance. The player reached it holding 11 scraps
// against an 18-scrap cheapest row -- at book 4, 99% of those shops were a
// shelf of grey rows. Repricing for a customer two rooms in would have made the
// shop cheap everywhere else, so lbmaze.SHOP_MIN_DIST fixed it where it broke.
{
    out.placement = { shops: 0, layouts: 0, minDist: Infinity, near: 0,
                      atEnd: 0, missing: 0, distHist: {} };
    for (let whiteness = 0; whiteness < 5; whiteness++) {
        for (let k = 0; k < 1200; k++) {
            const seed = seedFrom("place:" + whiteness + ":" + k);
            const layout = maze.bindVolume(seed, "v" + whiteness);
            out.placement.layouts += 1;
            const shops = layout.rooms.filter(function (r) {
                return r.kind === maze.KIND.SHOP;
            });
            if (!shops.length) { out.placement.missing += 1; }
            const bossDist = (layout.rooms.filter(function (r) {
                return r.id === layout.bossId;
            })[0] || {}).distance || 0;
            shops.forEach(function (r) {
                const dist = r.distance || 0;
                out.placement.shops += 1;
                out.placement.minDist = Math.min(out.placement.minDist, dist);
                out.placement.distHist[dist] =
                    (out.placement.distHist[dist] || 0) + 1;
                if (dist < maze.SHOP_MIN_DIST) { out.placement.near += 1; }
                // A shop as far out as the boss is money with nowhere left to
                // be spent.
                if (dist >= bossDist) { out.placement.atEnd += 1; }
            });
        }
    }
    if (out.placement.minDist === Infinity) { out.placement.minDist = 0; }
    out.shopMinDist = maze.SHOP_MIN_DIST;
}

// --- refusals ----------------------------------------------------------------
//
// Every path that must decline. A shop that lets a broke player buy is the
// same defect class as lbgear.fuse() being paid for by the caller.
{
    const rand = createRandom(seedFrom("refuse"));
    const mkRun = function (scraps, hpShare) {
        const f = fighterFor(12);
        f.hp = Math.max(1, Math.round(f.stats.hp * hpShare));
        return { scraps, gear: [{ slot: "brush", variant: "ho", tier: 2 }],
                 fighter: f };
    };

    const gearRow = { kind: "gear", price: 40,
                      piece: gear.makePiece("paper", "usu", 2), sold: false };
    const healRow = { kind: "heal", price: 26, share: shop.HEAL_SHARE,
                      sold: false };
    const fuseRow = { kind: "fuse", price: 8, slot: "brush", variant: "ho",
                      tier: 2, sold: false };

    const cases = [
        { label: "broke, gear", item: Object.assign({}, gearRow),
          run: mkRun(39, 0.5), want: "poor" },
        { label: "broke by one, fusion (fee + fuseCost)",
          item: Object.assign({}, fuseRow),
          run: mkRun(8 + gear.fuseCost(2) - 1, 0.5), want: "poor" },
        { label: "exactly enough, fusion",
          item: Object.assign({}, fuseRow),
          run: mkRun(8 + gear.fuseCost(2), 0.5), want: null },
        { label: "already sold", item: Object.assign({}, gearRow, { sold: true }),
          run: mkRun(9999, 0.5), want: "sold" },
        { label: "full HP, heal", item: Object.assign({}, healRow),
          run: mkRun(9999, 1), want: "full" },
        { label: "fusion for a piece no longer worn",
          item: Object.assign({}, fuseRow, { slot: "mark", variant: "himo" }),
          run: mkRun(9999, 0.5), want: "gone" },
        { label: "fusion for a tier the player no longer holds",
          item: Object.assign({}, fuseRow, { tier: 3 }),
          run: mkRun(9999, 0.5), want: "gone" }
    ];

    cases.forEach(function (c) {
        const before = c.run.scraps;
        const gearBefore = JSON.stringify(c.run.gear);
        const hpBefore = c.run.fighter.hp;
        const res = shop.buy(c.item, c.run, rand);
        out.refusals.push({
            label: c.label,
            want: c.want,
            got: res.ok ? null : res.why,
            ok: res.ok,
            // A refusal must change nothing at all.
            spent: before - c.run.scraps,
            gearChanged: gearBefore !== JSON.stringify(c.run.gear),
            hpChanged: hpBefore !== c.run.fighter.hp
        });
    });
}

// --- healing -----------------------------------------------------------------
//
// The heal is a share of the maximum, and the maximum comes from stats, not
// from the HP carried in (§3.6 keeps damage across rooms). Reading it off the
// current value would make the shop heal less the more hurt the player is.
for (const share of [0.05, 0.4, 0.85, 1.0]) {
    const f = fighterFor(20);
    const max = f.stats.hp;
    f.hp = Math.max(1, Math.round(max * share));
    const run = { scraps: 9999, gear: [], fighter: f };
    const row = { kind: "heal", price: 1, share: shop.HEAL_SHARE, sold: false };
    const res = shop.buy(row, run, createRandom(seedFrom("heal" + share)));
    out.heal.push({
        startShare: share,
        max: max,
        before: Math.max(1, Math.round(max * share)),
        after: f.hp,
        healed: res.ok ? res.healed : 0,
        over: f.hp > max
    });
}

// --- a whole book ------------------------------------------------------------
//
// The figure the module exists for. A book hands out 86-321 scraps
// (tools/check_lb_gear.py) and they vanish at the end of the run (§3.8). If the
// shops a book contains cannot absorb that, the scraps are decoration.
//
// Rooms come from lbmaze so the shop count is the real one, not an assumed one.
{
    const ROOMS = 13;
    const DROP_CHANCE = 0.34;
    const RUNS = 2000;

    for (let whiteness = 0; whiteness < 5; whiteness++) {
        let leftover = 0;
        let earned = 0;
        let spent = 0;
        let shopRooms = 0;
        let bought = { gear: 0, heal: 0, fuse: 0, redraw: 0 };
        let brokeAtShop = 0;
        let redraws = 0;
        let slots = 0;
        let tierSum = 0;
        let pieces = 0;
        let worth = 0;
        let overMax = 0;
        let purseAtShop = 0;
        let cheapestAtShop = 0;
        let cheapestGear = 0;
        let gearRowsSeen = 0;
        let gearAffordable = 0;
        let healRowsSeen = 0;
        let healAffordable = 0;

        for (let k = 0; k < RUNS; k++) {
            const v = vol(whiteness);
            const seed = seedFrom("book:" + whiteness + ":" + k);
            const layout = maze.bindVolume(seed, v.id);
            const run = { scraps: 0, gear: [], fighter: fighterFor(12) };
            run.fighter.hp = Math.max(1, Math.round(run.fighter.stats.hp * 0.6));

            // Walk the rooms in id order. Not the real route, but it visits
            // each room once, which is what §3.2's ratio is stated over.
            const rooms = layout.rooms.slice(0, ROOMS + 1);
            rooms.forEach(function (room) {
                const rand = createRandom(maze.roomSeed(seed, room.id + 0x5f10));
                const boss = room.kind === maze.KIND.BOSS;

                // Income first, then the shelf: the room is cleared on entry,
                // so laby.js has already paid out by the time the shop can be
                // opened. Shopping before the room's own scraps land would
                // under-report what a shop can absorb.
                if (room.kind === maze.KIND.SHOP) {
                    const paid = shop.scrapsFor(whiteness, false, rand);
                    run.scraps += paid;
                    earned += paid;

                    shopRooms += 1;
                    const srand = createRandom(maze.roomSeed(seed, room.id));
                    let anyAfford = false;

                    // What the shelf asks against what the player is holding.
                    //
                    // This is the figure that catches a price slope drifting
                    // away from the award formula. Spend-share cannot: with a
                    // redraw row absorbing whatever is left over, a shelf
                    // priced at a twelfth of its proper cost still reports
                    // ~68% spent (measured 0.683 -> 0.696 under a broken
                    // slope). The ratio of asking price to purse is what
                    // actually moves.
                    {
                        const peek = shop.stockFor(v, room.id, createRandom(
                            maze.roomSeed(seed, room.id)), run);
                        const prices = peek.map(function (it) {
                            return it.price
                                + (it.kind === "fuse"
                                   ? gear.fuseCost(it.tier) : 0);
                        });
                        const gearPrices = peek.filter(function (it) {
                            return it.kind === "gear";
                        }).map(function (it) { return it.price; });
                        purseAtShop += run.scraps;
                        cheapestAtShop += Math.min.apply(null, prices);
                        const healRow = peek.find(function (it) {
                            return it.kind === "heal";
                        });
                        if (healRow) {
                            healRowsSeen += 1;
                            if (healRow.price <= run.scraps) {
                                healAffordable += 1;
                            }
                        }
                        if (gearPrices.length) {
                            gearRowsSeen += 1;
                            cheapestGear += Math.min.apply(null, gearPrices);
                            if (Math.min.apply(null, gearPrices) <= run.scraps) {
                                gearAffordable += 1;
                            }
                        }
                    }
                    // Buy greedily, cheapest first, then pay to restock while
                    // scraps and redraws remain. A floor on what a shop can
                    // absorb, not a strategy -- a player who banks for one
                    // expensive row spends less, which is their choice to make.
                    for (let pass = 0; pass <= shop.REDRAW_MAX; pass++) {
                        const items = shop.stockFor(v, room.id + pass * 977,
                                                    srand, run);
                        items.slice().sort(function (a, b) {
                            return a.price - b.price;
                        }).forEach(function (it) {
                            const before = run.scraps;
                            const res = shop.buy(it, run, srand);
                            if (!res.ok) { return; }
                            anyAfford = true;
                            spent += before - run.scraps;
                            bought[res.kind] = (bought[res.kind] || 0) + 1;
                            if (res.kind === "gear") {
                                takeGear(run, res.piece);
                            }
                        });
                        if (pass === shop.REDRAW_MAX) { break; }
                        const fee = shop.redrawPrice(pass, whiteness);
                        if (run.scraps < fee) { break; }
                        run.scraps -= fee;
                        spent += fee;
                        redraws += 1;
                        bought.redraw = (bought.redraw || 0) + 1;
                    }
                    if (!anyAfford) { brokeAtShop += 1; }
                    return;
                }

                // Every room pays, not just the fights. A room with no enemies
                // is `cleared` on entry ([].every() is true), so laby.js runs
                // awardRoom on caches, puzzles and the entrance as well.
                // Modelling only fights here halved the income and made the
                // spend-share look worse than the game's.
                const got = shop.scrapsFor(whiteness, boss, rand);
                run.scraps += got;
                earned += got;
                if (rand.next() >= (boss ? 1 : DROP_CHANCE)) { return; }
                takeGear(run, gear.rollDrop(whiteness, rand,
                                            gear.emptySlots(run.gear)));
            });

            leftover += run.scraps;
            slots += run.gear.length;
            run.gear.forEach(function (p) {
                pieces += 1;
                tierSum += p.tier;
                if (p.tier > gear.TIER_MAX) { overMax += 1; }
            });
            const naked = stat.baseStats({ classId: 0, elementId: 0, level: 12 });
            const dressed = stat.applyEffects(naked, gear.loadoutEffects(run.gear));
            worth += Math.exp(stat.STAT_IDS.reduce(function (a, id) {
                return a + Math.log(naked[id] > 0 ? dressed[id] / naked[id] : 1);
            }, 0) / stat.STAT_IDS.length);
        }

        out.books.push({
            whiteness,
            runs: RUNS,
            shopsPerRun: Math.round(1000 * shopRooms / RUNS) / 1000,
            // One decimal: the gate quotes these next to spentShare, which is
            // computed off the totals. Rounding them to integers made the
            // failure message state arithmetic that did not add up (48% shown
            // beside 38/90).
            earned: Math.round(10 * earned / RUNS) / 10,
            spent: Math.round(10 * spent / RUNS) / 10,
            leftover: Math.round(10 * leftover / RUNS) / 10,
            redrawsPerShop: Math.round(1000 * redraws / Math.max(1, shopRooms))
                / 1000,
            spentShare: earned > 0 ? Math.round(1000 * spent / earned) / 1000 : 0,
            bought: Object.keys(bought).reduce(function (a, k) {
                a[k] = Math.round(1000 * bought[k] / RUNS) / 1000;
                return a;
            }, {}),
            brokeAtShop: Math.round(1000 * brokeAtShop / Math.max(1, shopRooms)) / 1000,
            slotsFilled: Math.round(1000 * slots / RUNS) / 1000,
            meanTier: Math.round(1000 * tierSum / Math.max(1, pieces)) / 1000,
            overMax,
            setWorth: Math.round(1000 * worth / RUNS) / 1000,

            // The asking price against the purse that has to meet it. Held as
            // a ratio because that is the thing a price slope is supposed to
            // hold steady across books: income grows 3.67x, so prices must
            // too, or the deep books are either unaffordable or free.
            cheapestShare: purseAtShop > 0
                ? Math.round(1000 * cheapestAtShop / purseAtShop) / 1000 : 0,
            cheapestGearShare: purseAtShop > 0
                ? Math.round(1000 * cheapestGear / purseAtShop) / 1000 : 0,
            // How often a gear row is one the player can actually take. The
            // greedy buyer's `bought.gear` falls 0.61 -> 0.01 across books
            // because it spends on heals and fusions first; that is the
            // buyer's ordering, not the shelf's fault. Affordability is the
            // figure that says whether the shelf is offering real goods.
            gearAffordable: gearRowsSeen > 0
                ? Math.round(1000 * gearAffordable / gearRowsSeen) / 1000 : 0,
            gearRowsSeen,
            healAffordable: healRowsSeen > 0
                ? Math.round(1000 * healAffordable / healRowsSeen) / 1000 : 0,
            healRowsSeen,

            // The price of each kind at this book, so the gate can assert the
            // *shape* of the table rather than an aggregate a sink can absorb.
            // Two rules, opposite directions:
            //   - tiered goods (gear, fuse) must not move across books; the
            //     tier already carries depth.
            //   - untiered goods (heal, redraw) must move with income, or they
            //     become pocket change in the deep books.
            goodsPrice: {
                heal: shop.priceOf({ kind: "heal" }, whiteness),
                redraw: shop.priceOf({ kind: "redraw" }, whiteness),
                fuse: shop.priceOf({ kind: "fuse", tier: 1 }, whiteness),
                gear2: shop.priceOf(
                    { kind: "gear", piece: { tier: 2 } }, whiteness),
                gear4: shop.priceOf(
                    { kind: "gear", piece: { tier: 4 } }, whiteness)
            },
            incomePerRoom: shop.scrapsFor(whiteness, false, null)
        });
    }
}

// Mirrors game/laby.js takeGear(). Kept in step by hand; the gate checks the
// figures it produces, which is what would move if they drifted.
function takeGear(run, piece) {
    const list = run.gear;
    for (let i = 0; i < list.length; i++) {
        if (list[i].slot !== piece.slot) { continue; }
        if (gear.canFuse(list[i], piece)) {
            const made = gear.fuse(list[i], piece, run.scraps | 0);
            if (made) {
                run.scraps -= made.spent;
                list[i] = made.piece;
                return "fused";
            }
        }
        if (gear.weight([piece]) > gear.weight([list[i]])) {
            list[i] = piece;
            return "worn";
        }
        return "dropped";
    }
    list.push(piece);
    return "worn";
}

process.stdout.write(JSON.stringify(out));
