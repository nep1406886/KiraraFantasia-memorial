// 白紙の書架 — 房データの検査を node から回すための足場。
//
// core/rooms.js をそのまま読み込んで、asset/mv/R*.json を実物として渡す。
// 検査script が Python で表を書き直すのでは無く「配られる JSON」を通す、
// というのがここの一点: 生成器と検査が同じ思い違いをしていても、片方が表を
// 持たなければ食い違いは出る。
//
// 出力は JSON 一つ。tools/check_mv_rooms.py が読む。

// 置き場所について: この file は core/ に写して回す。core/rooms.js が
// `../site/asset/mv/abilities.js` を読むので、平らな一時 directory に全部並べると
// import が解けない。核と asset/mv の二階層をそのまま写す方が、指定子を書き
// 換えずに済む — 書き換えると「検査した物」と「配る物」が別になる。
//
// 読む JSON の path は引数で受ける。module の位置からの相対にすると、写した
// 側の空の asset/ を読んでしまう。

import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
    REGION_IDS, START_REGION, GOAL_REGION,
    validateRegion, buildAtlas, checkSeams, regionGraph, solve, selfLocked,
    traverseGaps, climbBreaks, REACH
} from "./rooms.js";
import { ABILITY_IDS, GATE_TYPES, gateOpen } from "../site/asset/mv/abilities.js";
import { keyOf as modelKeyOf } from "./mvmanifest.js";

const MV_DIR = process.argv[2] || "site/asset/mv";
const MANIFEST = process.argv[3] || "site/asset/models/manifest.json";

function loadRegions() {
    return REGION_IDS.map(function (id) {
        const text = readFileSync(join(MV_DIR, id + ".json"), "utf8");
        return JSON.parse(text);
    });
}

// 全排列走査。6 能力を 6 区へ置く 720 通りのうち、解けるのは幾つか。
// 計画 §5.4 は 432/720 と書いている。ここでその数を真の JSON の辺で出す。
function permutationScan(graph) {
    const homes = ["R1", "R2", "R3", "R4", "R5", "R6"];
    const results = [];
    const perm = homes.slice();

    function permute(k, emit) {
        if (k === perm.length) { emit(perm.slice()); return; }
        for (let i = k; i < perm.length; i++) {
            const t = perm[k]; perm[k] = perm[i]; perm[i] = t;
            permute(k + 1, emit);
            const u = perm[k]; perm[k] = perm[i]; perm[i] = u;
        }
    }

    let solvable = 0, total = 0;
    permute(0, function (order) {
        // order[i] = ABILITY_IDS[i] を置く区
        const grants = {};
        REGION_IDS.forEach(function (r) { grants[r] = []; });
        ABILITY_IDS.forEach(function (ab, i) { grants[order[i]].push(ab); });
        const r = solve({ edges: graph.edges, grants: grants }, START_REGION);
        total++;
        const ok = r.reached.size === REGION_IDS.length
            && r.held.size === ABILITY_IDS.length
            && r.reached.has(GOAL_REGION);
        if (ok) { solvable++; }
        results.push(ok);
    });
    return { solvable: solvable, total: total };
}

function main() {
    const out = { errors: [] };
    const regions = loadRegions();

    // 1. schema
    const problems = [];
    regions.forEach(function (r) { validateRegion(r, problems); });
    out.schemaProblems = problems;

    const atlas = buildAtlas(regions);
    out.roomCount = Object.keys(atlas.rooms).length;
    out.perRegion = {};
    regions.forEach(function (r) {
        out.perRegion[r.id] = Object.keys(r.rooms).length;
    });

    // 2. つなぎ目
    out.seamProblems = checkSeams(atlas);

    // 3. 房の中の跳躍到達性 — 横と縦の両方。
    const gapBreaks = [];
    const climbFails = [];
    Object.keys(atlas.rooms).forEach(function (roomId) {
        traverseGaps(atlas.rooms[roomId]).forEach(function (b) {
            gapBreaks.push(Object.assign({ room: roomId }, b));
        });
        climbBreaks(atlas.rooms[roomId]).forEach(function (b) {
            climbFails.push(Object.assign({ room: roomId }, b));
        });
    });
    out.gapBreaks = gapBreaks;
    out.climbBreaks = climbFails;
    // 天井に出口が在る房の数。0 なら上の検査は何も見ていないので、それ自体が
    // 報告に要る (地図が横一本に戻った時に気付けるように)。
    out.roomsWithCeilingExit = Object.keys(atlas.rooms).filter(function (id) {
        return (atlas.rooms[id].edges || []).some(function (e) {
            return e.side === "U";
        });
    }).length;

    // 4. 区グラフと不動点探索
    const graph = regionGraph(atlas);
    out.edgeCount = graph.edges.length;
    out.grants = graph.grants;
    const solved = solve(graph, START_REGION);
    out.reached = Array.from(solved.reached).sort();
    out.held = Array.from(solved.held).sort();
    out.order = solved.order;
    out.goalReachable = solved.reached.has(GOAL_REGION);
    out.selfLocked = selfLocked(graph);

    // 5. 全排列
    out.permutations = permutationScan(graph);

    // 6. 門と能力の対応。門の型が七種のままか、need が型と噛み合っているか。
    const gateTypes = {};
    Object.keys(atlas.rooms).forEach(function (roomId) {
        (atlas.rooms[roomId].gate || []).forEach(function (g) {
            gateTypes[g.type] = (gateTypes[g.type] || 0) + 1;
        });
    });
    out.gateTypes = gateTypes;

    // 軟門 (bond) は能力を持たなくても開く。これが進行を止めない事の確認。
    out.bondOpensWithoutAbilities = gateOpen("bond", [], true);
    out.bondClosedUnread = gateOpen("bond", ABILITY_IDS, false);

    // 7. 拾い物と書桌
    const pickups = [], desks = [];
    Object.keys(atlas.rooms).forEach(function (roomId) {
        (atlas.rooms[roomId].pickup || []).forEach(function (p) {
            pickups.push({ room: roomId, ability: p.ability });
        });
        if ((atlas.rooms[roomId].desk || []).length) {
            desks.push({ room: roomId, blanch: atlas.rooms[roomId].blanch });
        }
    });
    out.pickups = pickups.sort(function (a, b) { return a.ability < b.ability ? -1 : 1; });
    out.desks = desks;

    // 8. 敵モデルが manifest に居るか、patrol が動く物かどうか。
    // 阶段 4 の門だが、房データはもう spawns を持っているので今から測れる。
    let manifest = null;
    try {
        manifest = JSON.parse(readFileSync(MANIFEST, "utf8"));
    } catch (err) {
        out.errors.push("manifest unreadable: " + err.message);
    }
    if (manifest) {
        const unknown = [], staticPatrol = [];
        Object.keys(atlas.rooms).forEach(function (roomId) {
            (atlas.rooms[roomId].spawns || []).forEach(function (s) {
                // core/mvstage.js と同じ引き方。書き付けの "model/enemy/" では
                // §4.7 B3 の model_pl_ が「manifest に無い」と出る。
                let key = null;
                try { key = modelKeyOf(s.model); } catch (err) {
                    unknown.push({ room: roomId, model: s.model });
                    return;
                }
                const entry = manifest.models[key];
                if (!entry) { unknown.push({ room: roomId, model: s.model }); return; }
                if (s.behavior === "patrol" && !entry.animations) {
                    staticPatrol.push({ room: roomId, model: s.model });
                }
            });
        });
        out.unknownModels = unknown;
        out.staticPatrol = staticPatrol;
        out.animatedEnemies = Object.keys(manifest.models).filter(function (k) {
            return k.indexOf("/enemy/") !== -1 && manifest.models[k].animations;
        }).length;
    }

    // 8.5 場面が置かれている房を、避けて通れるかどうかで分ける。
    //
    // 過場は房の script で開く。だから筋の場面が「通らなくても済む房」に在ると、
    // その場面は在るのに一度も出ない — 門も検査も何も鳴らない。phase 5 の門は
    // 「id が解けるか」しか見ていないので、そこは誰も見ていなかった。
    //
    // 判定は房を一つ外して起点から終点へ歩けるかどうか。能力の need は無視する:
    // 門は道を減らす方向にしか働かないので、「全部の扉が開いていても迂回できない」
    // なら本当に必ず通る。逆向きに間違える (必ず通ると言い過ぎる) 事が無い。
    // 歩き方は solve() と同じ不動点で、単位が区ではなく房。門を無視して
    // 単純な幅優先で歩くと、捷径 10 本が全部開いている事になって房が一つも
    // 「必ず通る」にならない (実測: 22 房中 20 房が迂回可能と出た)。捷径は
    // その先で拾う能力で開くので、門を見ないと迂回路の数を数え過ぎる。
    const START_ROOM = "R0-01", GOAL_ROOM = "R7-08";
    function reaches(skip) {
        if (START_ROOM === skip || GOAL_ROOM === skip) { return false; }
        const seen = new Set([START_ROOM]);
        const held = new Set();
        function gain(id) {
            ((atlas.rooms[id] || {}).pickup || []).forEach(function (p) {
                held.add(p.ability);
            });
        }
        gain(START_ROOM);
        let changed = true;
        while (changed) {
            changed = false;
            Array.from(seen).forEach(function (id) {
                ((atlas.rooms[id] || {}).edges || []).forEach(function (e) {
                    if (e.ability && !held.has(e.ability)) { return; }
                    const to = String(e.to || "").split(":")[0];
                    if (!to || to === skip || seen.has(to) || !atlas.rooms[to]) { return; }
                    seen.add(to);
                    gain(to);
                    changed = true;
                });
            });
        }
        return seen.has(GOAL_ROOM);
    }
    out.scriptRooms = Object.keys(atlas.rooms).filter(function (id) {
        return atlas.rooms[id].script;
    }).sort().map(function (id) {
        return { room: id, scene: atlas.rooms[id].script, mandatory: !reaches(id) };
    });
    // 起点抜きで終点に着けるか。着けるなら上の判定は全部無意味なので、
    // それ自体を報告に出す (地図が繋がっていない時に気付けるように)。
    out.goalRoomReachable = reaches(null);

    // 9. 捷径が進行を担っていない事 (§5.4 の追加検査)。
    //
    // 「捷径」の印は房データに書いていない。書くと、書き忘れたものが黙って
    // 主線扱いになる。代わりに区番号で決める: 隣の区へ行く辺だけが主線で、
    // R0→R5 や R1→R7 のように番号が飛ぶものは捷径。定義が一行で済むし、
    // 房データを増やしても勝手に判別が付く。
    const spineOnly = graph.edges.filter(function (e) {
        return Math.abs(Number(e.from.slice(1)) - Number(e.to.slice(1))) === 1;
    });
    out.spineEdgeCount = spineOnly.length;
    out.shortcutEdgeCount = graph.edges.length - spineOnly.length;
    const spineSolved = solve({ edges: spineOnly, grants: graph.grants }, START_REGION);
    out.spineOnly = {
        reached: spineSolved.reached.size,
        held: spineSolved.held.size,
        goal: spineSolved.reached.has(GOAL_REGION)
    };

    process.stdout.write(JSON.stringify(out, null, 1) + "\n");
}

main();
