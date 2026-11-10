// Authored tactics for additional original cards. IDs persist in saved decks.
// Shared archetypes describe mechanics; each card chooses a cost/cadence and a trait.
// The catalogue builder reads COMPANIONS to resolve its exact native art and actions.
const BASE = {
    fighter: { family:"战士", kind:"fighter", hp:240, range:2.2, windup:.42, deployCooldown:10 },
    shooter: { family:"魔法使", kind:"shooter", hp:145, range:9, windup:19/30, projectileSpeed:15, deployCooldown:12 },
    guard: { family:"骑士", kind:"guard", hp:1050, range:1.6, windup:.45, deployCooldown:22 },
    healer: { family:"僧侣", kind:"healer", hp:170, range:4, windup:16/30, deployCooldown:14 },
    lobber: { family:"炼金术士", kind:"lobber", hp:155, range:8, windup:12/30, flight:.64, deployCooldown:12 }
};
const TACTICS = {
    duelist: ["fighter", "蓄力连斩", { special:{every:3,type:"power",multiplier:2.2} }],
    fencer: ["fighter", "会心剑舞", { special:{every:4,type:"critical",multiplier:2.6} }],
    breaker: ["fighter", "破防先锋", { onHit:{vulnerable:.18,vulnerableDuration:3}, special:{every:4,type:"power",multiplier:1.8} }],
    dancer: ["fighter", "越战越快", { tempo:{per:.035,max:.21}, special:{every:5,type:"critical",multiplier:2} }],
    sweeper: ["fighter", "横扫拦截", { cleave:true, special:{every:4,type:"knockback",distance:.6} }],
    sharpshot: ["shooter", "聚光会心", { special:{every:4,type:"critical",multiplier:2.6} }],
    wave: ["shooter", "贯路魔法", { special:{every:4,type:"wave",damage:54} }],
    petals: ["shooter", "绽放轰击", { splash:.8,splashDamage:12,special:{every:5,type:"power",multiplier:2} }],
    tempo: ["shooter", "疾速施法", { tempo:{per:.03,max:.24},special:{every:5,type:"power",multiplier:1.8} }],
    trio: ["shooter", "三路交响", { multi:{rows:1,gap:.16},special:{every:5,type:"critical",multiplier:1.8} }],
    bulwark: ["guard", "坚壁诱导", { tall:true,guardPeriod:11,guardDuration:4,guardReduction:.35 }],
    ward: ["guard", "屏障守卫", { barrier:{hits:2,period:15},special:{every:4,type:"power",multiplier:2} }],
    shelter: ["guard", "邻近守护", { protection:.12,guardPeriod:12,guardDuration:3,guardReduction:.3 }],
    regrowth: ["guard", "自愈前排", { selfHeal:{ratio:.13,period:12},cleave:true }],
    mend: ["healer", "远程急救", { range:5.2 }],
    chorus: ["healer", "群体疗愈", { area:true }],
    encore: ["healer", "疗愈加速", { healHaste:{amount:.16,duration:3} }],
    sanctuary: ["healer", "疗愈护盾", { healShield:22,maxShield:70 }],
    fortify: ["healer", "守护疗愈", { protection:.08 }],
    frailty: ["lobber", "削攻药剂", { onHit:{weaken:.28,weakenDuration:4,splash:.6,splashDamage:8} }],
    fracture: ["lobber", "破防药剂", { onHit:{vulnerable:.28,vulnerableDuration:4} }],
    frost: ["lobber", "迟缓干扰", { onHit:{slow:.3,slowDuration:2.5,delayAttack:.4} }],
    snare: ["lobber", "束缚药剂", { onHit:{slow:.2,slowDuration:2},special:{every:4,type:"stun",duration:1.5} }],
    catalyst: ["lobber", "扩散药剂", { onHit:{splash:1,splashDamage:14,vulnerable:.15,vulnerableDuration:3} }]
};
// [stable id, original card, display name, work, tactic, cost, damage/heal, period, optional trait]
export const COMPANIONS = [
["U96",10022001,"寻","向阳素描","petals",200,25,1.9,{special:{every:4,type:"critical",multiplier:2.4}}],
["U97",11002001,"野野原柚子","悠悠式","duelist",100,32,1.15],
["U98",12022001,"若狭悠里","学园孤岛","tempo",180,20,1.45,{splash:.5,splashDamage:7}],
["U99",13012001,"百木伦","A Channel","encore",145,64,3.4,{range:4.5}],
["U100",14042001,"猪熊阳子（运动会）","黄金拼图","dancer",135,24,.95],
["U101",15022001,"篠田初（圣诞节）","NEW GAME!","duelist",125,39,1.35,{hp:280}],
["U102",16012001,"藤川歌夜","斯特拉的魔法","catalyst",175,19,2.1],
["U103",17072001,"花园椿","Urara 迷路帖","sharpshot",205,31,2,{splash:.55,splashDamage:8}],
["U104",18022001,"吴织亚切","爱杀宝贝","frailty",165,15,1.9,{protection:.08}],
["U105",19002001,"高山春香","樱 Trick","sanctuary",155,52,3.6],
["U106",20012001,"日向夏帆（泳装）","Blend S","dancer",125,22,.85,{hp:210}],
["U107",21032001,"百地玉手","Slow Start","duelist",115,35,1.3,{special:{every:5,type:"power",multiplier:2.8}}],
["U108",23042001,"齐藤惠那（七夕）","摇曳露营△","shelter",150,15,2.7,{hp:1000,tall:true}],
["U109",24022001,"色川琉姬","Comic Girls","frost",155,18,2.2,{onHit:{slow:.25,slowDuration:3,weaken:.2,weakenDuration:3}}],
["U110",25002001,"山口如月","GA 艺术科美术设计班","fortify",160,62,3.5,{selfHeal:{ratio:.1,period:12}}],
["U111",26012001,"橘勇鱼（女儿节）","食梦者玛莉","trio",230,17,1.9],
["U112",27032001,"西御门多美","花舞少女","duelist",150,43,1.5,{special:{every:3,type:"power",multiplier:2.4}}],
["U113",28012001,"云雀丘琉璃","Anne Happy♪","sharpshot",190,35,2.2,{hp:110,special:{every:3,type:"critical",multiplier:2.4}}],
["U114",29012001,"比嘉彼方","遥的接球","wave",225,32,2.1,{special:{every:4,type:"wave",damage:75}}],
["U115",30082001,"青山老师（新年）","请问您今天要来点兔子吗？","sanctuary",175,42,3.8,{healShield:35,maxShield:100}],
["U116",31012001,"有马日诘（女仆）","Anima Yell!","frailty",135,21,2.3],
["U117",32032001,"波尔卡","闪耀幻想曲","breaker",125,35,1.35,{special:{every:4,type:"critical",multiplier:2.2}}],
["U118",33002001,"西川叶子","三者三叶","wave",155,20,1.8],
["U119",34002001,"小黑","棺材、旅人、怪蝙蝠","fracture",150,18,2.1,{special:{every:4,type:"critical",multiplier:2}}],
["U120",35022001,"莉莉丝（第2部）","街角魔族","sharpshot",210,28,1.9,{hp:220}],
["U121",37012001,"森野麒麟（运动会）","幸腹涂鸦","regrowth",170,26,2.5,{hp:850,special:{every:4,type:"power",multiplier:2}}],
["U122",38022001,"猪濑舞","恋爱小行星","dancer",160,30,1.1,{tempo:{per:.04,max:.28}}],
["U123",39022001,"川口芳乃","球咏","fracture",155,15,2,{onHit:{vulnerable:.22,vulnerableDuration:4,slow:.2,slowDuration:3}}],
["U124",40022001,"贯井羽优（泳装）","满溢的水果挞","duelist",165,47,1.65,{onHit:{slow:.2,slowDuration:2}}],
["U125",41022001,"片濑真宵","一起一起这里那里","tempo",165,22,1.6],
["U126",42002001,"篠华茉优","Power of Smile","regrowth",135,16,2.8,{hp:1100}],
["U127",43012001,"橘妮娜","こはる日和。","chorus",155,31,4.3,{healHaste:{amount:.1,duration:2}}],
["U128",44002001,"里中千惠","Manga Time","chorus",170,40,4.8,{healShield:10,maxShield:35}],
["U129",45012001,"芳（泳装）","RPG不动产","fencer",175,44,1.7,{pierceArmor:true}],
["U130",47002001,"海凪日和","Slow Loop","shelter",140,17,2.6,{hp:1150}],
["U131",22021001,"田井中律","轻音少女","bulwark",110,12,2.5,{hp:900,onHit:{weaken:.2,weakenDuration:3}}],
["U132",36011001,"坂本香树","晴海国度","chorus",125,25,4,{range:3.6}],
["U133",46021001,"山田凉","孤独摇滚！","fracture",150,14,2.8,{onHit:{vulnerable:.4,vulnerableDuration:4,slow:.25,slowDuration:3}}],
["U134",10052001,"荠（泳装）","向阳素描","catalyst",160,16,2.2,{onHit:{splash:.8,splashDamage:10,vulnerable:.2,vulnerableDuration:3,slow:.15,slowDuration:2}}],
["U135",11022001,"日向缘","悠悠式","petals",190,29,2.1,{special:{every:4,type:"wave",damage:62}}],
["U136",12032001,"直树美纪","学园孤岛","bulwark",140,25,2.9,{special:{every:4,type:"power",multiplier:2},hp:1000}],
["U137",13022001,"西由宇子（圣诞节）","A Channel","ward",155,22,2.8,{hp:950}],
["U138",14052001,"松原穗乃花","黄金拼图","breaker",145,31,1.2,{tempo:{per:.025,max:.15}}],
["U139",15032001,"饭岛结音（女儿节）","NEW GAME!","bulwark",145,23,2.7,{guardDuration:5,guardPeriod:13}],
["U140",16022001,"村上椎奈（情人节）","斯特拉的魔法","duelist",140,42,1.55,{range:2.5}],
["U141",17041001,"色井佐久","Urara 迷路帖","bulwark",100,18,2.8,{hp:850,deployCooldown:17}],
["U142",18002011,"折部安奈（新年）","爱杀宝贝","chorus",165,33,4.5,{hp:280,selfHeal:{ratio:.12,period:10}}],
["U143",19012001,"园田优","樱 Trick","fencer",135,30,1.1,{special:{every:3,type:"critical",multiplier:2.1}}],
["U144",20022001,"星川麻冬","Blend S","mend",140,62,3.2,{range:4.2,healHaste:{amount:.08,duration:3}}],
["U145",21042001,"万年大会","Slow Start","bulwark",125,16,2.5,{hp:1000,onHit:{weaken:.15,weakenDuration:4}}],
["U146",23052001,"土岐绫乃（新年）","摇曳露营△","sharpshot",220,26,1.8,{pierce:true,special:{every:5,type:"critical",multiplier:2}}],
["U147",24042001,"怖浦铃（温泉）","Comic Girls","mend",170,90,4,{range:5.5}],
["U148",25012001,"野田美希（万圣节）","GA 艺术科美术设计班","encore",150,48,3,{healHaste:{amount:.22,duration:2.4}}],
["U149",26022001,"安琪·三叶","食梦者玛莉","ward",200,18,2.8,{hp:900,protection:.1,lastStand:true}],
["U150",27042001,"常盘真智","花舞少女","fracture",160,12,2.1,{onHit:{vulnerable:.4,vulnerableDuration:5}}],
["U151",28022001,"久米川牡丹","Anne Happy♪","chorus",145,36,4.6,{hp:120,healHaste:{amount:.14,duration:2}}],
["U152",29022001,"托马斯·红爱（万圣节）","遥的接球","bulwark",165,27,2.7,{hp:1150,onHit:{weaken:.2,weakenDuration:3}}],
["U153",30002011,"保登心爱（圣诞节）","请问您今天要来点兔子吗？","encore",165,58,3.4,{healHaste:{amount:.2,duration:3.2}}],
["U154",31022001,"猿渡宇希","Anima Yell!","breaker",150,30,1.2,{protection:.07}],
["U155",32042001,"柯尔克","闪耀幻想曲","frailty",155,25,2.5,{onHit:{weaken:.35,weakenDuration:5}}],
["U156",33012001,"小田切双叶（泳装）","三者三叶","fortify",170,55,3.5,{hp:350,selfHeal:{ratio:.15,period:10}}],
["U157",35042001,"吉田良子（泳装）","街角魔族","fracture",180,18,2.3,{onHit:{vulnerable:.35,vulnerableDuration:5},special:{every:4,type:"power",multiplier:2}}],
["U158",37022001,"椎名","幸腹涂鸦","petals",175,25,2,{splash:1,splashDamage:14}],
["U159",38032001,"樱井美景（泳装）","恋爱小行星","sharpshot",195,24,1.6,{special:{every:5,type:"critical",multiplier:2.8}}],
["U160",39032001,"中村希","球咏","fencer",155,38,1.4,{special:{every:4,type:"critical",multiplier:3}}],
["U161",40032001,"前原仁菜（白色情人节）","满溢的水果挞","mend",175,105,4.5,{healShield:15,maxShield:45}],
["U162",41011001,"春野姬","一起一起这里那里","encore",120,44,3.1,{healHaste:{amount:.12,duration:2.5}}],
["U163",42012001,"虎道环","Power of Smile","fencer",180,42,1.55,{special:{every:3,type:"critical",multiplier:2.5}}],
["U164",43042001,"小野坂纱织（七夕）","こはる日和。","wave",215,30,2,{special:{every:3,type:"wave",damage:62}}],
["U165",44012001,"白井丽子","Manga Time","petals",225,33,2.1,{special:{every:4,type:"power",multiplier:2.4}}],
["U166",45021001,"露芙莉娅","RPG不动产","fortify",135,56,3.4,{protection:.1}],
["U167",47012001,"海凪小春（泳装）","Slow Loop","sanctuary",145,60,3.5,{healShield:15,maxShield:55}]
];
const pct = value => Math.round(value * 100) + "%";
function describe(r) {
    const parts = [];
    if(r.healing) parts.push(`每${r.period}秒为${r.area?"周围3×3内受伤伙伴":"同路最需要帮助的伙伴"}治疗${r.healing}点。`);
    else parts.push(`每${r.period}秒造成${r.damage}点${r.kind==="shooter"?"远程":r.kind==="lobber"?"投掷":"近身"}伤害。`);
    if(r.range&&r.healing&&!r.area) parts.push(`治疗距离${r.range}格。`);
    if(r.cleave) parts.push("近战横扫范围内所有来敌。");
    if(r.multi) parts.push("同时照顾本路与相邻两路。");
    if(r.pierce) parts.push("弹体贯穿整路。");
    if(r.splash) parts.push(`落点${r.splash}格内溅射${r.splashDamage}点。`);
    const s=r.special;
    if(s) parts.push(`每第${s.every}次攻击${s.type==="wave"?"释放贯路魔法，造成"+s.damage+"点伤害":s.type==="knockback"?"击退"+s.distance+"格":s.type==="stun"?"束缚"+s.duration+"秒":(s.type==="critical"?"会心，":"强化，")+"伤害×"+s.multiplier}。`);
    if(r.tempo) parts.push(`每次攻击提速${pct(r.tempo.per)}，最多${pct(r.tempo.max)}。`);
    for(const [key,label,time] of [["vulnerable","易伤","vulnerableDuration"],["weaken","削攻","weakenDuration"],["slow","减速","slowDuration"]])
        if(r.onHit?.[key])parts.push(`命中${label}${pct(r.onHit[key])}，持续${r.onHit[time]}秒。`);
    if(r.onHit?.delayAttack)parts.push(`推迟敌方出手${r.onHit.delayAttack}秒。`);
    if(r.onHit?.splash)parts.push(`落点${r.onHit.splash}格内溅射${r.onHit.splashDamage}点。`);
    if(r.tall)parts.push("可拦截越障来敌。");
    if(r.guardPeriod)parts.push(`每${r.guardPeriod}秒可进入减伤${pct(r.guardReduction)}的守势，持续${r.guardDuration}秒。`);
    if(r.barrier)parts.push(`每${r.barrier.period}秒获得${r.barrier.hits}次抵挡屏障。`);
    if(r.selfHeal)parts.push(`每${r.selfHeal.period}秒自愈${pct(r.selfHeal.ratio)}生命。`);
    if(r.protection)parts.push(`周围3×3内其他伙伴减伤${pct(r.protection)}，同类取最高。`);
    if(r.healHaste)parts.push(`有效治疗后提速${pct(r.healHaste.amount)}，持续${r.healHaste.duration}秒。`);
    if(r.healShield)parts.push(`有效治疗同时附加${r.healShield}护盾，上限${r.maxShield}。`);
    if(r.lastStand)parts.push("每次部署可抵挡一次致命伤并回满生命。");
    if(r.pierceArmor)parts.push("攻击击碎护甲。");
    return parts.join("");
}
export const COMPANION_RULES = Object.fromEntries(COMPANIONS.map(([id,cardId,name,work,tactic,cost,power,period,trait])=>{
    const [kind,role,mechanics]=TACTICS[tactic];
    const rule={id,name,role,...BASE[kind],...mechanics,cost,period,
        [kind==="healer"?"healing":"damage"]:power,...trait};
    rule.help=describe(rule);
    return [id,Object.freeze(rule)];
}));
