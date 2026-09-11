#!/usr/bin/env node
// Exact roster scene/action dependencies. Runtime ownership is tested in the
// browser; resource presence and source-string matches cannot prove it.
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { PLAYABLE_ROSTER } from "../site/game/rl/rosterids.js";
import { createSkills } from "../site/game/rl/skills.js";

const root = new URL("../", import.meta.url);
const read = path => JSON.parse(readFileSync(new URL(path, root), "utf8"));
const roster = PLAYABLE_ROSTER;
const cards = read("site/asset/rl/cards-rl.json").cards;
const table = read("site/asset/rl/skills-rl.json"), skills = table.player;
const playback = read("site/asset/battle/skill-playback.json");
const scenes = read("site/asset/uniqueskill/scene-index.json").scenes;
const timelines = read("site/asset/uniqueskill/timeline-index.json");
const manifest = read("site/asset/models/manifest.json");
const voices = read("site/asset/rl/voices.json");
const source = readFileSync(new URL("site/asset/battle/uniqueskill.js", root), "utf8");
const cues = JSON.parse(source.match(/window\.kirafanUniqueSkillData\s*=\s*(\{.*?\});/s)[1]).scenes;
assert.equal(roster.length, 41);
assert.equal(new Set(roster.map(row => row.id)).size, roster.length);
let cinematic = 0, generic = 0, voiced = 0;
const voiceGaps = [];
for (const entry of roster) {
    const id = entry.id;
    const card = cards.find(c => c.id === id);
    assert.ok(card, "missing card " + id);
    assert.equal(card.resourceId, entry.resourceId, "exact playable model " + id);
    assert.equal(card.class, entry.class, "exact playable class " + id);
    const skill = skills[card.skillIds.chara];
    assert.ok(skill, "missing original skill " + id);
    const identity = playback.models[String(card.resourceId)];
    assert.ok(identity, "model playback entry " + id);
    const exact = playback.cards[String(id)];
    assert.equal(exact.resourceId, card.resourceId, "source card model " + id);
    assert.equal(exact.ultimate.id, card.skillIds.chara, "source card skill " + id);
    assert.equal(exact.ultimate.sceneId, skill.sceneId, "source card scene " + id);
    // A model may be shared by multiple cards (e.g. Mira 380004). The game
    // selects the current card's skill, not the model browser's fallback card.
    const runtime = createSkills({ table, card, maxHp: 1000 });
    assert.equal(runtime.ultimate.id, card.skillIds.chara, "exact card skill " + id);
    assert.equal(runtime.ultimate.sceneId, skill.sceneId, "exact card scene " + id);
    assert.equal(runtime.ultimate.action, skill.action, "exact card action " + id);
    if (!skill.sceneId) {
        generic++;
        assert.match(skill.action, /^class_skill_[123]$/, "authored class action " + id);
        console.log("PASS " + id + " uses original " + skill.action + "; no borrowed cinematic");
        continue;
    }
    cinematic++;
    const rid = String(skill.sceneId);
    assert.ok(scenes[rid] && timelines[rid] && manifest.skillActions[rid], "scene/timeline/motion " + rid);
    assert.ok(existsSync(new URL(scenes[rid].file, root)), "scene file " + rid);
    const voice = cues["PL_" + rid + "_0"]?.voice;
    const local = voice && Object.values(voices).find(row => row.sheet === voice.sheet);
    if (!voice || !local) {
        voiceGaps.push({ cardId: id, sceneId: rid, sheet: voice?.sheet || null });
    } else {
        for (const [,cue] of voice.frames || []) {
            assert.ok(local.cues[cue], "missing cue " + rid + ":" + cue);
            assert.ok(existsSync(new URL("audio/voice/" + local.cues[cue], root)), "voice file " + cue);
        }
        voiced++;
    }
    console.log("PASS " + id + " -> exact scene/motion " + rid);
}
assert.equal(cinematic, 41);
assert.equal(generic, 0);
assert.equal(cinematic + generic, roster.length);
console.log("PASS 41 current identities: 41 original cinematics, no borrowed fallback scenes");
console.log("Audio coverage (separate from scene coverage): " + voiced + "/" + cinematic);
if (voiceGaps.length) console.log("DOCUMENTED AUDIO GAPS " + JSON.stringify(voiceGaps));
