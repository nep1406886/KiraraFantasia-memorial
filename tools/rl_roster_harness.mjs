// Current playable identities and their shipped data/model/skill closure.
// DOM callbacks and layout are covered by rl_roster_entry_harness and browsers.
import assert from "node:assert/strict";
import { readFileSync, statSync } from "node:fs";
import { PLAYABLE_ROSTER, PLAYABLE_IDS } from "../site/game/rl/rosterids.js";
import { createStats } from "../site/asset/rl/stats.js";

const root = new URL("../", import.meta.url);
const read = name => JSON.parse(readFileSync(new URL(name, root), "utf8"));
const cards = read("site/asset/rl/cards-rl.json").cards;
const skills = read("site/asset/rl/skills-rl.json");
const models = read("site/asset/models/manifest.json").models;
const images = read("site/asset/rl/images.json");
const stats = createStats({ cards, growth: read("site/asset/rl/growth.json") });
assert.equal(PLAYABLE_ROSTER.length, 41, "首发范围为 41 张五星卡，不是旧档身份数量");
assert.equal(new Set(PLAYABLE_IDS).size, 41, "可玩卡 ID 不重复");
assert.deepEqual(read("site/asset/rl/playable-roster.json").cards, PLAYABLE_ROSTER);
let checks = 3;
const names = new Set(), classes = new Set(), elements = new Set();
for (const identity of PLAYABLE_ROSTER) {
    const card = cards.find(row => row.id === identity.id);
    assert.ok(card, "真实角色表必须包含 " + identity.id);
    assert.equal(card.rare, 5);
    assert.equal(card.class, identity.class);
    assert.equal(card.resourceId, identity.resourceId);
    assert.ok(card.characterZh && !names.has(card.characterZh), "不能按同名截断或复用另一张卡");
    names.add(card.characterZh); classes.add(card.class); elements.add(card.element);
    assert.ok(Number.isInteger(card.element) && card.element >= 0 && card.element <= 5);
    assert.ok(Number.isInteger(card.class) && card.class >= 0 && card.class <= 4);
    const model = models["model/player/model_pl_" + card.resourceId + ".muast"];
    assert.ok(model && model.animations, "模型与动作入口 " + card.id);
    assert.ok(statSync(new URL("site/" + model.file.split("?")[0], root)).size > 100);
    const image = images.find(row => row.category === "card" && Number(row.id) === card.id);
    assert.ok(image && image.w > 1 && image.h > 1, "当前卡面必须存在，不能只保留旧常服卡面");
    for (const id of [card.skillIds.chara, ...card.skillIds.class]) {
        assert.ok(skills.player[id], "本卡技能行 " + id);
    }
    for (const level of [1, 20, 80, 100]) {
        const values = stats.statsFor(card.id, level);
        for (const key of ["hp", "atk", "mgc", "def", "mdef", "spd"]) {
            assert.ok(Number.isFinite(values[key]) && values[key] > 0, card.id + ":" + level + ":" + key);
        }
    }
    checks++;
    console.log("PASS 当前卡面、职业、模型、技能与成长 " + card.id);
}
assert.equal(classes.size, 5, "五职业齐全");
assert.equal(elements.size, 6, "属性使用 0..5，不能丢掉火属性");
const claire = PLAYABLE_ROSTER.find(row => row.id === 32022001);
assert.ok(claire && claire.class === 1 && claire.resourceId === 320204, "克蕾尔使用当前五星魔法使模型");
checks += 3;
console.log("Roster data: " + checks + " checks passed; DOM/browser gates remain separate");
