import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const DATABASE_ROOT = "https://database.kirafan.cn/database";
const TRANSLATION_ROOT = "https://trans.kirafan.cn";
const ORIGINAL_TITLE_TYPE = 22;
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outputPath = resolve(root, "asset", "gacha", "cards.js");

async function fetchJson(name) {
    const response = await fetch(`${DATABASE_ROOT}/${name}.json`);
    if (!response.ok) {
        throw new Error(`Failed to fetch ${name}: HTTP ${response.status}`);
    }
    return response.json();
}

const [characters, namedCharacters, titles, weapons, translations, englishTranslations, assetBundles, version, translationVersion] = await Promise.all([
    fetchJson("CharacterList"),
    fetchJson("NamedList"),
    fetchJson("TitleList"),
    fetchJson("WeaponList"),
    fetch(`${TRANSLATION_ROOT}/zh.json`).then((response) => response.json()),
    fetch(`${TRANSLATION_ROOT}/en.json`).then((response) => response.json()),
    fetch(`${DATABASE_ROOT}/../assetBundle.json`).then((response) => response.json()),
    fetch(`${DATABASE_ROOT}/../version`).then((response) => response.text()),
    fetch(`${TRANSLATION_ROOT}/version`).then((response) => response.text())
]);

const namedById = new Map(namedCharacters.map((item) => [item.m_NamedType, item]));
const titleById = new Map(titles.map((item) => [item.m_TitleType, item]));
const characterById = new Map(characters.map((item) => [item.m_CharaID, item]));
const assetNames = new Set(assetBundles.map((item) => item.name));
const dedicatedWeaponByCharacterId = new Map(
    weapons
        .filter((weapon) => weapon.m_EquipableCharaID > 0 && weapon.m_EvolvedCount === 0)
        .map((weapon) => [weapon.m_EquipableCharaID, weapon])
);
// 通用武器：m_EquipableCharaID <= 0 的那 105 行，谁都能装。三族：
//   standard  1C00..1C10  每职业 11 把，从「装備無し」到「スターソード」；
//   event     21C0x       活动奖励，每职业 2~3 把；
//   character 七位数       ★5 角色自带的「デフォルトぶき / 汎用ぶき」。这些
//             行的 m_EquipableCharaID 也是 -1，所以在数据里算通用，但模型是
//             那个角色专属的；砂糖、生姜这些 ★5 原创角色的默认武器只存在于
//             这一族里（她们没有 m_EquipableCharaID > 0 的专用武器行）。
// 观察台原先只认 1C00 一把，另外 100 把在页面上没有入口。
const GENERIC_WEAPON_FAMILY_ORDER = { standard: 0, event: 1, character: 2 };

function weaponFamily(id) {
    if (id < 20000) {
        return "standard";
    }
    return id < 100000 ? "event" : "character";
}

// 括号里的标签跟【】那套一样要单独翻，zh.json 只收了本名。
const parenSuffixes = {
    zh: { "サンリオ": "三丽鸥", "マンガ": "漫画版", "第2部": "第2部" },
    en: { "サンリオ": "Sanrio", "マンガ": "Manga", "第2部": "Part 2" }
};

const genericSlotSuffixes = {
    zh: { "デフォルトぶき": "默认武器", "汎用ぶき": "通用武器" },
    en: { "デフォルトぶき": "Default", "汎用ぶき": "Generic" }
};

function fullIllustrationName(id) {
    return `texture/charauiresource/charaillustfull/charaillust_full_${id}.muast`;
}

const nameSuffixes = {
    zh: {
        "水着": "泳装",
        "温泉": "温泉",
        "七夕": "七夕",
        "第2部": "第2部",
        "ブライダル": "婚礼",
        "成長版": "成长版",
        "大人版": "成人版"
    },
    en: {
        "水着": "Swimsuit",
        "温泉": "Onsen",
        "七夕": "Tanabata",
        "第2部": "Part 2",
        "ブライダル": "Bridal",
        "成長版": "Grown-up",
        "大人版": "Adult"
    }
};

const titleOverrides = {
    zh: {
        "RPG不動産": "RPG不动产",
        "スローループ": "Slow Loop",
        "ぱわーおぶすまいる。": "Power of Smile",
        "ぼっち・ざ・ろっく！": "孤独摇滚！",
        "まんがタイム": "Manga Time"
    },
    en: {
        "RPG不動産": "RPG Real Estate",
        "スローループ": "Slow Loop",
        "ぱわーおぶすまいる。": "Power of Smile",
        "ぼっち・ざ・ろっく！": "Bocchi the Rock!",
        "まんがタイム": "Manga Time"
    }
};

function translateName(source, translations, language) {
    if (translations[source]) {
        return translations[source];
    }
    const variant = /^(.*?)【([^】]+)】$/.exec(source);
    if (!variant) {
        return source;
    }
    const base = translations[variant[1]] || variant[1];
    const suffix = nameSuffixes[language][variant[2]] || variant[2];
    return `${base}【${suffix}】`;
}

function translateTitle(source, translations, language) {
    return titleOverrides[language][source] || translations[source] || source;
}

// 武器名里的角色部分。zh.json 只收本名，（サンリオ）这类括号标签要单独查表。
function translateWeaponOwner(source, translations, language) {
    const paren = /^(.*?)（([^）]+)）$/.exec(source);
    if (!paren) {
        return translateName(source, translations, language);
    }
    const tag = parenSuffixes[language][paren[2]] || paren[2];
    return `${translateName(paren[1], translations, language)}（${tag}）`;
}

// 通用武器名。zh.json 收了 60/105（standard 全收，event 收了 5），剩下的是
// ★5 那一族，名字是「★5 + 角色名 + デフォルトぶき/汎用ぶき」这种内部命名。
// 拆开翻：角色名走 translateName（它认得【】变体），标签查表，拼回去。翻不动
// 就原样返回 —— 宁可显示日文原名，也不要显示一个猜的名字。
function translateWeaponName(source, translations, language) {
    if (translations[source]) {
        return translations[source];
    }
    const generic = /^(★5|きららファンタジア　)(.+?)[　]?(デフォルトぶき|汎用ぶき)$/.exec(source);
    if (!generic) {
        return source;
    }
    const slot = genericSlotSuffixes[language][generic[3]];
    return `★5 ${translateWeaponOwner(generic[2], translations, language)} ${slot}`;
}

// 专用武器名。zh.json 一条都没收（0/162），但名字是「★5 + 角色名 + 専用 +
// 武器名词」，而那 41 个名词里有 23 个 zh.json 自己就收了（クリスタル→水晶、
// ロッド→魔棒……）。所以照样拆开翻，名词查不到就留日文 —— 同一条规矩：不猜。
function translateDedicatedWeaponName(source, translations, language) {
    if (translations[source]) {
        return translations[source];
    }
    const match = /^(★\d)?(.+?)専用(.+)$/.exec(source);
    if (!match) {
        return source;
    }
    const star = match[1] ? `${match[1]} ` : "";
    const who = translateWeaponOwner(match[2], translations, language);
    const noun = translations[match[3]] || match[3];
    return language === "en" ? `${star}${who}'s ${noun}` : `${star}${who} 专用${noun}`;
}

const genericWeapons = weapons
    .filter((weapon) => weapon.m_EquipableCharaID <= 0 && weapon.m_EvolvedCount === 0)
    .map((weapon) => ({
        id: weapon.m_ID,
        name: weapon.m_WeaponName,
        nameZh: translateWeaponName(weapon.m_WeaponName, translations, "zh"),
        nameEn: translateWeaponName(weapon.m_WeaponName, englishTranslations, "en"),
        class: weapon.m_ClassType,
        family: weaponFamily(weapon.m_ID),
        rarity: weapon.m_Rare + 1,
        // 双持职业（class 3 盾枪）左右填的是同一个 ID；单手职业只填 R。
        resourceIdL: weapon.m_ResourceID_L > 0 ? weapon.m_ResourceID_L : null,
        resourceIdR: weapon.m_ResourceID_R > 0 ? weapon.m_ResourceID_R : null,
        classAnimType: weapon.m_ClassAnimType
    }))
    .sort((left, right) => left.class - right.class
        || GENERIC_WEAPON_FAMILY_ORDER[left.family] - GENERIC_WEAPON_FAMILY_ORDER[right.family]
        || left.id - right.id);

// 专用武器：m_EquipableCharaID > 0 的那 162 行，数据上绑死在某个 ★5 角色身上。
// 观察台把它们也列出来 —— 挂点是手上的 Loc_<side>，跟职业和角色都无关，所以
// 「给谁装谁的武器」在渲染上完全成立。162 把的 GLB 本地全都有。
const dedicatedWeapons = weapons
    .filter((weapon) => weapon.m_EquipableCharaID > 0 && weapon.m_EvolvedCount === 0)
    .map((weapon) => ({
        id: weapon.m_ID,
        name: weapon.m_WeaponName,
        nameZh: translateDedicatedWeaponName(weapon.m_WeaponName, translations, "zh"),
        nameEn: translateDedicatedWeaponName(weapon.m_WeaponName, englishTranslations, "en"),
        class: weapon.m_ClassType,
        family: "dedicated",
        rarity: weapon.m_Rare + 1,
        charaId: weapon.m_EquipableCharaID,
        resourceIdL: weapon.m_ResourceID_L > 0 ? weapon.m_ResourceID_L : null,
        resourceIdR: weapon.m_ResourceID_R > 0 ? weapon.m_ResourceID_R : null,
        classAnimType: weapon.m_ClassAnimType
    }))
    .sort((left, right) => left.class - right.class || left.id - right.id);

const cards = characters
    .filter((card) => card.m_CharaID % 10 === 0)
    .filter((card) => {
        const named = namedById.get(card.m_NamedType);
        return Boolean(named);
    })
    .map((card) => {
        const named = namedById.get(card.m_NamedType);
        const title = titleById.get(named.m_TitleType);
        const evolved = characterById.get(card.m_CharaID + 1);
        const hasEvolution = Boolean(
            evolved &&
            evolved.m_NamedType === card.m_NamedType &&
            evolved.m_Rare === card.m_Rare &&
            evolved.m_Class === card.m_Class &&
            evolved.m_Element === card.m_Element
        );
        if (!title) {
            throw new Error(`Missing title ${named.m_TitleType} for card ${card.m_CharaID}`);
        }
        const dedicatedWeapon = dedicatedWeaponByCharacterId.get(hasEvolution ? evolved.m_CharaID : card.m_CharaID)
            || dedicatedWeaponByCharacterId.get(card.m_CharaID)
            || null;
        return {
            id: card.m_CharaID,
            name: card.m_Name,
            nameZh: translateName(card.m_Name, translations, "zh"),
            nameEn: translateName(card.m_Name, englishTranslations, "en"),
            character: named.fullName || named.m_FullName || named.m_NickName,
            characterZh: translations[named.fullName || named.m_FullName || named.m_NickName] || named.fullName || named.m_FullName || named.m_NickName,
            characterEn: englishTranslations[named.fullName || named.m_FullName || named.m_NickName] || named.fullName || named.m_FullName || named.m_NickName,
            title: title.m_DisplayName,
            titleZh: translateTitle(title.m_DisplayName, translations, "zh"),
            titleEn: translateTitle(title.m_DisplayName, englishTranslations, "en"),
            titleId: named.m_TitleType,
            namedType: card.m_NamedType,
            resourceId: card.m_ResourceID,
            headId: card.m_HeadID,
            dedicatedAnimType: card.m_DedicatedAnimType,
            displayScale: card.m_DispScale,
            rarity: card.m_Rare + 1,
            evolvedId: hasEvolution ? evolved.m_CharaID : null,
            evolvedResourceId: hasEvolution ? evolved.m_ResourceID : null,
            evolvedHeadId: hasEvolution ? evolved.m_HeadID : null,
            evolvedDedicatedAnimType: hasEvolution ? evolved.m_DedicatedAnimType : null,
            dedicatedWeapon: dedicatedWeapon ? {
                id: dedicatedWeapon.m_ID,
                name: dedicatedWeapon.m_WeaponName,
                resourceIdL: dedicatedWeapon.m_ResourceID_L > 0 ? dedicatedWeapon.m_ResourceID_L : null,
                resourceIdR: dedicatedWeapon.m_ResourceID_R > 0 ? dedicatedWeapon.m_ResourceID_R : null,
                classAnimType: dedicatedWeapon.m_ClassAnimType
            } : null,
            hasFullIllustration: assetNames.has(fullIllustrationName(card.m_CharaID)),
            evolvedHasFullIllustration: hasEvolution && assetNames.has(fullIllustrationName(evolved.m_CharaID)),
            class: card.m_Class,
            element: card.m_Element,
            limited: Boolean(card.isPeriodLimited),
            distributed: Boolean(card.isDistributed),
            year: card.year || null
        };
    })
    .sort((left, right) => left.id - right.id);

const cardIds = new Set(cards.map((card) => card.id));
const characterIds = new Set(cards.map((card) => card.namedType));
const includedTitleIds = new Set(cards.map((card) => card.titleId));
const evolutionCount = cards.filter((card) => card.evolvedId !== null).length;
const originalCards = cards.filter((card) => card.titleId === ORIGINAL_TITLE_TYPE);
const originalCharacterIds = new Set(originalCards.map((card) => card.namedType));

if (cardIds.size !== cards.length) {
    throw new Error("Duplicate card IDs found in generated gacha data");
}
if (
    cards.length < 680 ||
    characterIds.size < 240 ||
    !includedTitleIds.has(ORIGINAL_TITLE_TYPE) ||
    originalCards.length !== 51 ||
    originalCharacterIds.size !== 21
) {
    throw new Error("Generated data failed completeness or original-character checks");
}
// 五个职业每族都得有东西，否则观察台的武器下拉会空掉一整个职业。
const genericClasses = new Set(genericWeapons.map((weapon) => weapon.class));
const genericDefaults = new Set(genericWeapons.map((weapon) => weapon.id));
if (
    genericWeapons.length < 100 ||
    genericClasses.size !== 5 ||
    ![0, 1, 2, 3, 4].every((klass) => genericDefaults.has(1000 + klass * 100))
) {
    throw new Error("Generated data failed generic-weapon checks");
}
// 专用武器同理，而且两张表的 ID 不能撞 —— 下拉是按 ID 反查行的。
const dedicatedClasses = new Set(dedicatedWeapons.map((weapon) => weapon.class));
const clashingWeaponIds = dedicatedWeapons.filter((weapon) => genericDefaults.has(weapon.id));
if (
    dedicatedWeapons.length < 160 ||
    dedicatedClasses.size !== 5 ||
    clashingWeaponIds.length > 0
) {
    throw new Error("Generated data failed dedicated-weapon checks");
}

const includedTitles = titles
    .filter((title) => includedTitleIds.has(title.m_TitleType))
    .map((title) => ({
        id: title.m_TitleType,
        name: title.m_DisplayName,
        nameZh: translateTitle(title.m_DisplayName, translations, "zh"),
        nameEn: translateTitle(title.m_DisplayName, englishTranslations, "en")
    }))
    .sort((left, right) => left.name.localeCompare(right.name, "ja"));

const payload = {
    meta: {
        databaseVersion: version.trim(),
        translationVersion: translationVersion.trim(),
        cardCount: cards.length,
        characterCount: characterIds.size,
        titleCount: includedTitles.length,
        evolutionCount,
        genericWeaponCount: genericWeapons.length,
        dedicatedWeaponCount: dedicatedWeapons.length,
        originalTitleType: ORIGINAL_TITLE_TYPE,
        originalCardCount: originalCards.length,
        originalCharacterCount: originalCharacterIds.size,
        sources: [
            "https://database.kirafan.cn/database/CharacterList.json",
            "https://database.kirafan.cn/database/NamedList.json",
            "https://database.kirafan.cn/database/TitleList.json",
            "https://database.kirafan.cn/database/WeaponList.json",
            "https://database.kirafan.cn/assetBundle.json",
            "https://trans.kirafan.cn/zh.json",
            "https://trans.kirafan.cn/en.json"
        ]
    },
    titles: includedTitles,
    genericWeapons,
    dedicatedWeapons,
    cards
};

const output = [
    "// Generated by scripts/generate-gacha-data.mjs. Do not edit by hand.",
    `window.kirafanGachaData = ${JSON.stringify(payload)};`,
    ""
].join("\n");

await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, output, "utf8");

console.log(`Generated ${cards.length} cards / ${characterIds.size} characters / ${includedTitles.length} titles / ${genericWeapons.length} generic weapons / ${dedicatedWeapons.length} dedicated weapons.`);
