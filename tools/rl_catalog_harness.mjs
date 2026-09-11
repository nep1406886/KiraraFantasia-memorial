// Original weapon truth, live stat application, eligible drops and save compatibility.
import assert from "node:assert/strict";
import fs from "node:fs";
import { createHash } from "node:crypto";
import { setWeaponCatalog, weaponDefinition, canEquipWeapon, rollWeapon } from "../site/game/rl/weaponcatalog.js";
import { setAffixPool, rollLoot } from "../site/game/rl/loot.js";
import { setAffixTable, affixTableFromPassives, applyEquipment, passiveRuntime, previewEquipment } from "../site/game/rl/equipment.js";
import { createWorld } from "../site/game/rl/world.js";
import { createRandom } from "../site/game/rl/random.js";
import { buildRunPayload, parseRunSnapshot } from "../site/game/rl/runschema.js";

const root = new URL("../", import.meta.url);
const read = name => JSON.parse(fs.readFileSync(new URL(name, root), "utf8"));
const data = read("site/asset/rl/weapons-rl.json");
setWeaponCatalog(data.catalog);
setAffixPool(Object.keys(data.passives), data.weapons.map(row => row.id));
setAffixTable(affixTableFromPassives(data.passives));
const base = { hp: 1000, atk: 100, mgc: 80, def: 50, mdef: 40, spd: 100, luck: 0 };
const blade = { slot: "weapon", rarity: "common", catalogId: 1001, affixes: [] };
const warrior = { id: 15000000, class: 0, element: 0 };
const priest = { id: 10002001, class: 2, element: 0 };
let passed = 0;
function test(label, run) { run(); passed++; console.log("PASS " + label); }

test("802 stages, 224 named families and 62 generic weapons", () => {
    assert.equal(data.catalog.length, 802);
    assert.equal(new Set(data.catalog.map(row => row.id)).size, 802);
    assert.equal(new Set(data.catalog.map(row => row.iconId)).size, 224);
    assert.equal(data.catalog.filter(row => row.charaId < 0).length, 62);
    for (const row of data.catalog) {
        assert.ok(row.nameZh); assert.ok(row.maxLv >= row.minLv);
        assert.equal(row.iconId, row.id - row.evolution);
        assert.ok(row.skillId < 0 || data.skills[row.skillId]);
        assert.ok(row.passiveId < 0 || data.passives[row.passiveId]);
        for (const key of ["atk", "mgc", "def", "mdef"]) {
            assert.ok(Number.isInteger(row.max[key]) && row.max[key] >= row.init[key]);
        }
    }
});
test("all 224 icons exist locally with nonempty image records", () => {
    const images = read("site/asset/rl/images.json").filter(row => row.category === "weapon");
    assert.equal(images.length, 224);
    for (const id of new Set(data.catalog.map(row => row.iconId))) {
        const image = images.find(row => Number(row.id) === id);
        assert.ok(image); assert.ok(image.w >= 128 && image.h >= 128);
        assert.ok(fs.statSync(new URL("site/asset/img/rl/weapon/" + id + ".webp", root)).size > 100);
    }
});
const rawPath = new URL("site/asset/rl/_raw/WeaponList.json", root);
if (fs.existsSync(rawPath)) {
    test("every shipped stat and identity agrees with the archived WeaponList", () => {
        const bytes = fs.readFileSync(rawPath);
        assert.equal(createHash("sha256").update(bytes).digest("hex"), data.catalogSource.sha256);
        const source = new Map(JSON.parse(bytes.toString("utf8")).map(row => [row.m_ID, row]));
        for (const row of data.catalog) {
            const raw = source.get(row.id); assert.equal(raw.default, false);
            for (const [key, field] of [["name", "m_WeaponName"], ["class", "m_ClassType"],
                ["minLv", "m_InitLv"], ["maxLv", "m_LimitLv"], ["evolution", "m_EvolvedCount"],
                ["charaId", "m_EquipableCharaID"], ["skillId", "m_SkillID"], ["passiveId", "m_PassiveSkillID"]]) {
                assert.equal(row[key], raw[field]);
            }
            for (const key of ["Atk", "Mgc", "Def", "MDef"]) {
                assert.equal(row.init[key.toLowerCase()], raw["m_Init" + key]);
                assert.equal(row.max[key.toLowerCase()], raw["m_Max" + key]);
            }
        }
    });
}
test("old blade adds the original 30 attack before the 50 percent affix", () => {
    assert.equal(weaponDefinition(blade).maxLv, 20);
    assert.equal(applyEquipment(base, [blade]).atk, 130);
    const stronger = { ...blade, affixes: ["12012011"] };
    assert.equal(applyEquipment(base, [stronger]).atk, 195);
    assert.equal(applyEquipment(base, [stronger]).mgc, 80);
    for (let i = 0; i < 1000; i++) {
        applyEquipment(base, [stronger]); assert.equal(applyEquipment(base, []).atk, 100);
    }
});
test("stage 3 Yuno rod adds 648 magic defence; native overheal is applied once", () => {
    const rod = { ...blade, catalogId: 1000203 };
    assert.equal(applyEquipment(base, [rod]).mdef, 688);
    assert.equal(passiveRuntime([rod]).overheal, 1);
    assert.equal(passiveRuntime([{ ...rod, affixes: ["10002001", "10002001"] }]).overheal, 1);
    assert.equal(passiveRuntime([{ ...rod, catalogId: 1000200 }]).overheal, 0);
});
test("generic cross-class equipment has reduced proficiency; dedicated ownership remains strict", () => {
    assert.ok(canEquipWeapon(blade, warrior)); assert.ok(canEquipWeapon(blade, priest));
    assert.equal(applyEquipment(base, [blade], warrior).atk, 130);
    assert.equal(applyEquipment(base, [blade], priest).atk, 119.5);
    assert.ok(Math.abs(applyEquipment(base, [{ ...blade, affixes: ["12012011"] }], priest).atk - 158.3375) < 1e-9);
    assert.ok(previewEquipment(base, [], blade, { card: priest }));
    const rod = { ...blade, catalogId: 1000203 };
    assert.ok(canEquipWeapon(rod, priest));
    assert.ok(!canEquipWeapon(rod, { ...priest, id: 10002000 }));
    const old = { slot: "weapon", rarity: "legendary", weaponId: 10002001, affixes: ["10002001"] };
    assert.ok(canEquipWeapon(old, warrior));
    assert.equal(applyEquipment(base, [old]).mdef, 40);
    assert.equal(passiveRuntime([old]).overheal, 1);
    assert.equal(previewEquipment(base, [], rod, { card: warrior }), null);
    assert.equal(previewEquipment(base, [], { ...blade, catalogId: 999999 }, { card: warrior }), null);
});
test("seeded native rolls reach all 62 generic weapons and keep dedicated ownership", () => {
    const seen = new Set();
    for (let job = 0; job < 5; job++) {
        const rng = createRandom(123 + job), card = { id: 99, class: job };
        for (let i = 0; i < 5000; i++) {
            for (const item of rollLoot(rng, 5, 0, card, { slot: "weapon" })) {
                assert.ok(item.catalogId); assert.ok(canEquipWeapon(item, card));
                assert.equal(item.weaponId, undefined); seen.add(item.catalogId);
            }
        }
    }
    assert.equal(seen.size, 62);
    assert.equal(rollWeapon(() => 0, 1, "legendary", priest).id, 1000200);
    assert.equal(rollWeapon(() => 0, 4, "legendary", priest).id, 1000200);
    assert.equal(rollWeapon(() => 0, 5, "legendary", priest).id, 1000201);
    assert.equal(rollWeapon(() => 0, 13, "legendary", priest).id, 1000203);
    assert.equal(rollWeapon(() => 0, 20, "legendary", priest).id, 1000204);
    assert.equal(rollWeapon(() => 0, 20, "legendary", { id: 46002001, class: 3 }).id, 4600203);
});
test("native equipment round trips through v3 and rejects malformed references", () => {
    const snapshot = buildRunPayload({ schemaVersion: 3, seed: 7, volume: 1, floor: 1,
        cardId: warrior.id, level: 1, hp: 1000, equipment: [blade], roomClaims: [] });
    const saved = parseRunSnapshot(JSON.parse(JSON.stringify(snapshot)), 20);
    assert.deepEqual(saved.equipment, [blade]);
    for (const bad of [{ catalogId: "1001" }, { catalogId: -1 }, { catalogId: 1.2 },
        { slot: "amulet" }, { weaponId: 10002001 }]) {
        assert.equal(parseRunSnapshot({ ...snapshot, equipment: [{ ...blade, ...bad }] }, 20), null);
    }
});
test("actual equip, purchase and restored stats share the preview calculation", () => {
    const tables = { stats: { statsFor: () => ({ ...base }) }, skills: {} };
    const world = createWorld({ seed: 9, tables });
    const p = world.spawnPlayer({ card: warrior });
    const before = JSON.stringify([p.hp, p.base, p.equipment]);
    const view = world.previewEquipment(blade); assert.equal(view.candidate.atk, 130);
    assert.equal(JSON.stringify([p.hp, p.base, p.equipment]), before);
    const drop = { x: p.x, y: p.y, items: [blade] }; world.drops.push(drop);
    assert.ok(world.takeDrop(drop, blade)); assert.deepEqual(p.base, view.candidate);
    world.setDungeon({ start: 0, rooms: [{ id: 0, type: "shop", seed: 9, doors: {}, enemies: [] }] });
    const first = world.getShopOffer()[0]; assert.ok(first.item.catalogId);
    world.coin = 1000; const cost = first.price; const stats = world.previewEquipment(first.item).candidate;
    assert.ok(world.buyShopItem(0)); assert.equal(world.coin, 1000 - cost);
    assert.deepEqual(p.base, stats); assert.equal(world.buyShopItem(0), null);
    const restored = createWorld({ seed: 9, tables }).spawnPlayer({ card: warrior, equipment: p.equipment });
    assert.deepEqual(restored.base, stats);
    const second = world.getShopOffer()[1];
    second.item = { ...blade, catalogId: 1000203 }; const balance = world.coin;
    assert.equal(world.buyShopItem(1), null); assert.equal(world.coin, balance); assert.equal(second.bought, false);
    const crossClass = createWorld({ tables }).spawnPlayer({ card: priest, equipment: [blade] });
    assert.equal(crossClass.base.atk, 119.5);
    assert.equal(crossClass.weaponProfile.classId, 0);
    assert.equal(crossClass.card.class, 2);
    assert.throws(() => createWorld({ tables }).spawnPlayer({ card: warrior,
        equipment: [{ ...blade, catalogId: 1000203 }] }));
});
console.log("Weapon catalog: " + passed + "/" + passed + " passed");
