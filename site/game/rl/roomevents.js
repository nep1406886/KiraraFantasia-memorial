// Authored choices, separate from original character/weapon effects. Quotes do
// not draw the run RNG, so opening/cancelling cannot reroll a room's equipment.
import { hash32 } from './random.js';
import { makeGadget, gadgetDefinition, gadgetTerms, GADGETS } from './gadgets.js';

export const SUPPLY_CHOICES = Object.freeze(['heal', 'gauge', 'tune', 'commission']);
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

export function restEventChoices(seed, heal, gauge, floor = 1) {
    const roll = hash32('camp-event-v1:' + seed);
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

export function altarEventChoices(seed, maxHp, missingHp, floor = 1) {
    const roll = hash32('shrine-event-v1:' + seed);
    const heal = Math.min(Math.max(0, missingHp), Math.round(maxHp * .2));
    return [
        { id: 'calm', label: '静心祈愿', text: '不立誓约，只请星光照拂眼前的伤口。',
            benefit: '恢复生命 +' + heal, cost: '放弃本祭坛的刻印与契约', heal, gauge: 0 },
        gear('offering', '奉币换刻印', '将金币留在书册前，选择一条不同的作战道路。',
            makeGadget(SMALL[roll % SMALL.length]), .8),
        gear('oath', '星轨誓约', '献出一部分生命，借星轨协助普通攻击。持续代价随装备生效，替换后解除。',
            eventGadget(seed, 'shrine', floor, floor >= 9 ? 'hunter' : 'sentry'), 0, Math.max(1, Math.ceil(maxHp * .3)))
    ];
}
