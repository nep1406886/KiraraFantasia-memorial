// Copy the manifest entries of every enemy in ENEMY_RULES from the site-wide
// model manifest into the defense subset, so the page never loads the 1 MB
// full manifest. Re-run after adding an enemy.
import fs from "node:fs/promises";
import { ENEMY_RULES } from "../site/etowaria-defense/data/campaign.js";

const full = JSON.parse(await fs.readFile(new URL("../site/asset/models/manifest.json", import.meta.url), "utf8"));
const subsetUrl = new URL("../site/etowaria-defense/data/models.json", import.meta.url);
const subset = JSON.parse(await fs.readFile(subsetUrl, "utf8"));
const added = [];
for (const rule of Object.values(ENEMY_RULES)) {
    const key = `model/enemy/model_en_${rule.resourceId}.muast`;
    const entry = full.models[key];
    if (!entry) { throw new Error(`全站清单缺少魔物模型：${key}`); }
    if (!subset.models[key]) { added.push(key); }
    subset.models[key] = entry;
}
await fs.writeFile(subsetUrl, JSON.stringify(subset, null, 2) + "\n");
console.log(JSON.stringify({ enemies: Object.keys(ENEMY_RULES).length, added }, null, 1));
