export const TICK = 1 / 60;
export const SAVE_KEY = "etowaria-defense.campaign.v1";

export const UNIT_RULES = Object.freeze({
    F01: { id: "F01", name: "应援采集台", role: "经济", kind: "producer", cost: 50, deployCooldown: 7.5,
        hp: 180, firstIncome: 12, incomePeriod: 24, income: 25,
        help: "12秒后首次产出25クリエ，之后每24秒产出一次。先投资，还是先守住眼前的一路？" },
    U01: { id: "U01", name: "本田珠辉", role: "远程输出", kind: "shooter", cost: 100, deployCooldown: 7.5,
        hp: 140, damage: 20, period: 1.5, windup: 19 / 30, range: 9, projectileSpeed: 14, damageType: "magic",
        help: "向右攻击同一路来敌。每1.5秒准备一次土属性攻击，适合尽早建立稳定火力。" },
    U11: { id: "U11", name: "千矢", role: "挡线", kind: "guard", cost: 75, deployCooldown: 20,
        hp: 900, damage: 12, period: 2.6, windup: .45, range: 1.6, damageType: "physical",
        guardPeriod: 12, guardDuration: 4, guardReduction: .35,
        help: "高耐久骑士，定期进入增防姿态。把输出和治疗留在她身后；增防不等于完全格挡。" },
    U07: { id: "U07", name: "保登心爱", role: "近战支援", kind: "fighter", cost: 75, deployCooldown: 7.5,
        hp: 220, damage: 42, period: 1.2, windup: .42, range: 1.6, damageType: "physical",
        help: "只攻击同路前方的近身来敌。攻击力较高，但需要骑士照顾承伤；本轮先开放普通近战。" },
    U15: { id: "U15", name: "由乃", role: "治疗", kind: "healer", cost: 125, deployCooldown: 12,
        hp: 160, healing: 60, period: 3, windup: 16 / 30, range: 3.6,
        help: "治疗同一路、距离3.6格内生命比例最低的同伴。没有受伤目标时不会空放治疗。" },
    F10: { id: "F10", name: "紧急爆破术式", role: "救场", kind: "burst", cost: 150, deployCooldown: 40,
        windup: 1, damage: 1200, radius: 1.5,
        help: "放置爆破药瓶，1秒后打击附近三路、三列内的来敌。使用原药瓶模型，本作爆破改编，不让伙伴自爆。" }
});

export const ENEMY_RULES = Object.freeze({
    E01: { id: "E01", resourceId: 10000, name: "小黑怪", hp: 200, speed: .2,
        damage: 20, period: 1.2, windup: .32, height: .82, description: "缓慢前进，接近同伴后停下攻击。" },
    E02: { id: "E02", resourceId: 10100, name: "松鼠", hp: 140, speed: .34,
        damage: 18, period: 1, windup: .25, height: .92, description: "耐久较低，但脚步更快。不要让一条路长时间无人照顾。" },
    E04: { id: "E04", resourceId: 10200, name: "土台", hp: 680, speed: .12,
        damage: 28, period: 1.4, windup: .38, height: .82, description: "移动慢而耐久高。用骑士留住它，再由后排持续输出。" }
});

const spawn = (at, row, type = "E01", wave = 1) => ({ at, row, type, wave });

export const LEVELS = Object.freeze([
    {
        id: "1-1", title: "第一张布阵图", subtitle: "先准备应援，再照顾每一条路。",
        rows: 3, cols: 7, rowOffset: 1, colOffset: 1, startResource: 150,
        naturalFirst: 8, naturalPeriod: 16, naturalAmount: 25, warningLead: 6,
        waves: 3, estimate: "约3分钟", newEnemy: "E01",
        available: ["F01", "U01"], rewards: ["U11"],
        story: [
            { name: "本田珠辉", text: "我把布阵图画好了。先从中间这条路开始，再慢慢照顾另外两边吧。" },
            { name: "兰普", text: "先放应援采集台，再请本田珠辉帮忙。准备好后，点「开始巡守」。" }
        ],
        spawns: [spawn(28, 1), spawn(58, 1), spawn(72, 0, "E01", 2), spawn(90, 1, "E01", 2),
            spawn(116, 2, "E01", 2), spawn(144, 0, "E01", 3), spawn(148, 1, "E01", 3), spawn(152, 2, "E01", 3)],
        objective: "守住三条道路。每行有一次紧急驱离结界。",
        optional: "不消耗紧急结界", openingTip: "建议先在中路后方放应援台，再在它前面放本田珠辉。"
    },
    {
        id: "1-2", title: "多出来的两条路", subtitle: "别只顾着中间，快脚步也需要留意。",
        rows: 5, cols: 9, rowOffset: 0, colOffset: 0, startResource: 200,
        naturalFirst: 8, naturalPeriod: 16, naturalAmount: 25, warningLead: 6,
        waves: 4, estimate: "约4分钟", newEnemy: "E02", rewards: ["U07", "U15"],
        story: [
            { name: "千矢", text: "最前面的路交给我！不过，也要记得看看两边哦。" },
            { name: "兰普", text: "这次有五条路。松鼠跑得更快，来袭提示会告诉你它从哪里出现。" }
        ],
        spawns: [spawn(34, 2), spawn(50, 0), spawn(62, 4), spawn(76, 1, "E01", 2), spawn(90, 3, "E01", 2),
            spawn(106, 2, "E02", 2), spawn(110, 0, "E01", 2), spawn(126, 4, "E01", 3), spawn(140, 1, "E02", 3),
            spawn(148, 3, "E01", 3), spawn(170, 2, "E01", 4), spawn(172, 0, "E02", 4), spawn(176, 4, "E02", 4),
            spawn(180, 1, "E01", 4), spawn(184, 3, "E01", 4)],
        objective: "用经济和前排逐步建立五路防线。",
        optional: "不消耗紧急结界", openingTip: "可以先投两张应援台，再按来袭顺序补足每一路的输出。"
    },
    {
        id: "1-3", title: "把后背交给同伴", subtitle: "骑士挡在前面，治疗和输出各自做好一件事。",
        rows: 5, cols: 9, rowOffset: 0, colOffset: 0, startResource: 225,
        naturalFirst: 8, naturalPeriod: 16, naturalAmount: 25, warningLead: 7,
        waves: 4, estimate: "约4分钟", newEnemy: "E04", rewards: ["F10"],
        story: [
            { name: "由乃", text: "只要还能撑住，我就来帮忙恢复。请给后面的伙伴留一点位置。" },
            { name: "保登心爱", text: "那我也往前一步！这一边一起守，好吗？" }
        ],
        spawns: [spawn(34, 2), spawn(48, 0), spawn(60, 4), spawn(78, 1, "E01", 2), spawn(90, 3, "E01", 2),
            spawn(102, 2, "E04", 2), spawn(112, 0, "E02", 2), spawn(126, 4, "E02", 3), spawn(138, 1, "E04", 3),
            spawn(146, 3, "E01", 3), spawn(154, 2, "E01", 3), spawn(170, 4, "E04", 4), spawn(175, 0, "E04", 4),
            spawn(181, 1, "E02", 4), spawn(185, 3, "E02", 4), spawn(192, 2, "E01", 4)],
        objective: "前排承伤、同路治疗、后排输出，守住高耐久来敌。",
        optional: "至少完成一次有效治疗", openingTip: "由乃会照顾同一路受伤的同伴；隔着其他线路不能治疗。"
    }
]);

export function levelById(id) { return LEVELS.find(level => level.id === id) || null; }
export function unlockedUnits(completed = []) {
    const units = new Set(["F01", "U01"]);
    for (const level of LEVELS) {
        if (completed.includes(level.id)) { level.rewards.forEach(id => units.add(id)); }
    }
    return [...units];
}
export function canOpenLevel(id, completed = []) {
    const index = LEVELS.findIndex(level => level.id === id);
    return index >= 0 && (index === 0 || completed.includes(LEVELS[index - 1].id));
}
