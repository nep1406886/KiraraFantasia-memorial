// Authored choices, separate from original character/weapon effects. Quotes do
// not draw the run RNG, so opening/cancelling cannot reroll a room's equipment.
import { hash32 } from './random.js';
import { makeGadget, gadgetDefinition, gadgetTerms, GADGETS } from './gadgets.js';

// supply id 会随 claim.supply 落档（runschema.js 按本表校验），只增不改：
// heal/gauge/tune/commission 是现行集，其后是卷三/卷五营地变体的 8 个新 id。
export const SUPPLY_CHOICES = Object.freeze(['heal', 'gauge', 'tune', 'commission',
    'mead', 'glow', 'wax', 'hive', 'tea', 'line', 'ink', 'pen']);
const SMALL = ['rhythm', 'strider', 'reach', 'wide', 'aim'];
function gear(id, label, text, item, coinRate = 0, hpCost = 0) {
    const mechanic = gadgetDefinition(item);
    return { id, label: label + ' · ' + mechanic.name, text, item,
        coinCost: Math.ceil(mechanic.price * coinRate), hpCost, minFloor: mechanic.minFloor,
        ...gadgetTerms(item) };
}

function eventGadget(seed, source, floor, fallback) {
    const choices = [fallback, ...GADGETS.filter(row => row.contract && floor >= row.minFloor).map(row => row.id)];
    const id = choices[hash32(source + '-contract-v1:' + seed) % choices.length];
    const sealedSlot = id === 'binding' ? 1 + hash32(source + '-seal-v1:' + seed) % 2 : undefined;
    return makeGadget(id, undefined, sealedSlot);
}

// 非契约池：基础五件加上按层解锁的守望/巡猎，供卷四祭坛投币上弦抽取。
// 抽取池按当前层收窄，保证报价的每条道路在当前层都可启用。
function openGear(seed, source, floor) {
    const pool = [...SMALL, ...(floor >= 5 ? ['sentry'] : []), ...(floor >= 9 ? ['hunter'] : [])];
    return makeGadget(pool[hash32(source + '-open-v1:' + seed) % pool.length]);
}

function restChoices(seed, heal, gauge, floor, roll) {
    return [
        { id: 'heal', label: '共饮热茶', text: '坐下歇息，接受旅人的热茶和包扎。',
            benefit: '恢复生命 +' + heal, cost: '放弃本房间其他整备机会', heal, gauge: 0 },
        { id: 'gauge', label: '交换星光', text: '听完旅人的见闻，将收藏的星光留给下一场战斗。',
            benefit: '必杀槽 +' + gauge, cost: '不恢复生命，放弃本房间其他整备机会', heal: 0, gauge },
        gear('tune', '调校旅行战具', '旅人愿意分享一种战斗技巧，但旧槽位的装配需要让出来。',
            makeGadget(SMALL[roll % SMALL.length])),
        gear('commission', '接手旧机关', '支付修缮费，接下旅人携带的机关。先看清操作变化与代价，再决定是否装配。',
            eventGadget(seed, 'camp', floor, floor >= 9 && roll % 2 ? 'hunter' : 'sentry'), .6)
    ];
}

// 卷三「蜂蜜窖的交换」：营地整备的贪食之森变体，末位仍是契约机关。
function restBeehive(seed, heal, gauge, floor, roll) {
    return [
        { id: 'mead', label: '分饮蜜水', text: '蜂蜜窖的主人舀出一勺陈年蜜水，兑进旅人的水囊递给你。',
            benefit: '恢复生命 +' + heal, cost: '放弃本房间其他整备机会', heal, gauge: 0 },
        { id: 'glow', label: '留蜜引光', text: '把一滴蜂蜜封进小瓶，萤火便愿意聚在瓶口，陪你到下一场战斗。',
            benefit: '必杀槽 +' + gauge, cost: '不恢复生命，放弃本房间其他整备机会', heal: 0, gauge },
        gear('wax', '蜜蜡调校', '蜂蜡把松脱的机件重新封好。旅人只求一段见闻当谢礼。',
            makeGadget(SMALL[roll % SMALL.length])),
        gear('hive', '蜂巢机关', '蜂巢状的机关箱愿意随行，但要留下过路的蜜钱。先看清操作变化与代价，再决定是否装配。',
            eventGadget(seed, 'camp-hive', floor, floor >= 9 && roll % 2 ? 'hunter' : 'sentry'), .6)
    ];
}

// 卷五「终章的加笔」：两种契约并存——血墨对齐星轨誓约的生命定价，旧笔走修缮费。
function restFinalPage(seed, heal, gauge, floor, roll, maxHp) {
    return [
        { id: 'tea', label: '热茶照旧', text: '终章之前，旅人还是先给你倒了一杯热茶。故事再长，也要喘口气。',
            benefit: '恢复生命 +' + heal, cost: '放弃本房间其他整备机会', heal, gauge: 0 },
        { id: 'line', label: '续写一行', text: '在书册的空白处续一行小字，星光顺着字迹流进必杀槽。',
            benefit: '必杀槽 +' + gauge, cost: '不恢复生命，放弃本房间其他整备机会', heal: 0, gauge },
        gear('ink', '以血为墨', '像星轨誓约一样献出生命，把墨迹借给普通攻击。持续代价随装备生效，替换后解除。',
            eventGadget(seed, 'camp-ink', floor, floor >= 9 ? 'hunter' : 'sentry'), 0, Math.max(1, Math.ceil(maxHp * .3))),
        gear('pen', '接下旧笔', '旅人递来一支用旧的笔，附一页写满注记的纸。支付谢礼，接下这份机关。',
            eventGadget(seed, 'camp-pen', floor, floor >= 9 && roll % 2 ? 'hunter' : 'sentry'), .6)
    ];
}

// volume：第 3 卷营地换成蜂蜜窖，第 5 卷换成终章的加笔，其余用现行集。
// maxHp 只被卷五的血墨契约使用，对齐星轨誓约的 ceil(maxHp×.3) 定价。
export function restEventChoices(seed, heal, gauge, floor = 1, volume = 1, maxHp = 0) {
    const roll = hash32('camp-event-v1:' + seed);
    if (volume === 3) return restBeehive(seed, heal, gauge, floor, roll);
    if (volume === 5) return restFinalPage(seed, heal, gauge, floor, roll, maxHp);
    return restChoices(seed, heal, gauge, floor, roll);
}

function altarChoices(seed, maxHp, heal, floor, roll) {
    return [
        { id: 'calm', label: '静心祈愿', text: '不立誓约，只请星光照拂眼前的伤口。',
            benefit: '恢复生命 +' + heal, cost: '放弃本祭坛的刻印与契约', heal, gauge: 0 },
        gear('offering', '奉币换刻印', '将金币留在书册前，选择一条不同的作战道路。',
            makeGadget(SMALL[roll % SMALL.length]), .8),
        gear('oath', '星轨誓约', '献出一部分生命，借星轨协助普通攻击。持续代价随装备生效，替换后解除。',
            eventGadget(seed, 'shrine', floor, floor >= 9 ? 'hunter' : 'sentry'), 0, Math.max(1, Math.ceil(maxHp * .3)))
    ];
}

// 卷二「沙下的供品」：与现行祭坛同构的沉眠之沙变体，定价不变（.8×price / ceil(maxHp×.3)）。
function altarSands(seed, maxHp, heal, floor, roll) {
    return [
        { id: 'calm', label: '沙下静候', text: '不立誓约，只把埋在沙下的星光轻轻拂出来，照一照伤口。',
            benefit: '恢复生命 +' + heal, cost: '放弃本祭坛的刻印与契约', heal, gauge: 0 },
        gear('offering', '沙上奉币', '把金币埋进书册前的沙里，换一条不同的作战道路。',
            makeGadget(SMALL[roll % SMALL.length]), .8),
        gear('oath', '沙丘誓约', '献出一部分生命，借沙下星轨协助普通攻击。持续代价随装备生效，替换后解除。',
            eventGadget(seed, 'shrine-sand', floor, floor >= 9 ? 'hunter' : 'sentry'), 0, Math.max(1, Math.ceil(maxHp * .3)))
    ];
}

// 卷四「发条的誓约」：奉币上弦改抽非契约池（SMALL∪sentry/hunter），
// 齿隙立誓仍以生命为价换契约——不用纯金币换契约，避免动摇「契约=生命誓约」。
function altarClockwork(seed, maxHp, heal, floor, roll) {
    return [
        { id: 'calm', label: '静听齿轮', text: '不立誓约，只听机械之心在书页间走针的声音，让呼吸跟上来。',
            benefit: '恢复生命 +' + heal, cost: '放弃本祭坛的刻印与契约', heal, gauge: 0 },
        gear('offering', '投币上弦', '把金币投进齿轮缝里，机关为你换一条不同的作战道路上紧发条。',
            openGear(seed, 'shrine-cog', floor), .8),
        gear('oath', '齿隙立誓', '献出一部分生命，在齿隙间立下誓约，借机械协助普通攻击。持续代价随装备生效，替换后解除。',
            eventGadget(seed, 'shrine-cog', floor, floor >= 9 ? 'hunter' : 'sentry'), 0, Math.max(1, Math.ceil(maxHp * .3)))
    ];
}

// volume：第 2 卷祭坛换成沙下的供品，第 4 卷换成发条的誓约，其余用现行集。
export function altarEventChoices(seed, maxHp, missingHp, floor = 1, volume = 1) {
    const roll = hash32('shrine-event-v1:' + seed);
    const heal = Math.min(Math.max(0, missingHp), Math.round(maxHp * .2));
    if (volume === 2) return altarSands(seed, maxHp, heal, floor, roll);
    if (volume === 4) return altarClockwork(seed, maxHp, heal, floor, roll);
    return altarChoices(seed, maxHp, heal, floor, roll);
}
