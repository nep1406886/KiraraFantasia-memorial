# KiraraFantasia-memorial

《闪耀幻想曲》（きららファンタジア / Kirara Fantasia）服务终止后的纪念站点：倒计时器、角色模型素材库、必杀演出还原等，全部从游戏资产离线重建。

- 站点首页：<https://nep1406886.github.io/KiraraFantasia-memorial/>
- 倒计时器：<https://nep1406886.github.io/KiraraFantasia-memorial/index.html>
- 模型素材库：<https://nep1406886.github.io/KiraraFantasia-memorial/site/models.html>（1255 个角色模型 + 604 个敌人，5 个游戏动作/表情可调）
- 纪念召唤：<https://nep1406886.github.io/KiraraFantasia-memorial/site/gacha.html>
- 花笺旅记：`site/game/roguelike.html`，41 位同行者、五卷动作探索，在书页间战斗、成长与重逢。
- 星灯守望：`site/etowaria-defense/index.html`，167 张伙伴卡、5 类设施、五章三十二关与无尽巡守，编队守护小镇的灯火。

非官方同人作品，与芳文社、EXNOA 无关。游戏资产版权归原权利方所有。

本站的开发（含资产逆向、格式转换与渲染调试）大量借助了 AI（Claude）完成。

> 本项目最初基于上游 [icekirby/kirafan-timer](https://github.com/icekirby/kirafan-timer) 的活动倒计时器改造而来（灵感来源与起步代码），现已发展为独立的纪念站点，与上游功能基本不再重叠。

## 部署

推到 `master` 就由 [.github/workflows/static.yml](.github/workflows/static.yml) 上传到 GitHub Pages。

## 本地游玩与验证

在仓库根目录运行 `python tools/serve.py`，使用终端给出的本地地址进入上述游戏页面。资源通过 HTTP 加载，不要直接双击 HTML。两款游戏沿用纪念主页的粉白、莓粉与暖灰配色，导航可以互相切换并返回纪念主页。

花笺旅记的营地支持角色、作品、职业搜索与属性筛选；点卡片预览，再点出发按钮开始。战斗与首领房扩大至 40×30，种子控制弯曲道路和错落花圃，按生态组合原作植物、地景与建筑；道路和碰撞共用布局数据。首领具有分阶段招式、锁定预警、原作特效和反击窗口。职业决定基础攻击，默认辅助瞄准并允许攻击中移动。

植物风摆、水面波纹、流动云影与花瓣为地图增加持续动效，地面补充草簇、落花和花圃边石。场景仍按贴图合批，房间独立管理动态材质。剑弧和枪刺保留原作网格、贴图与时间线，从出手帧进入，并映射到真实攻击范围；准确光迹跟随人物与命中窗口。远程弹芯始终对应判定位置，并叠加原作轨迹，命中时在敌人接触位置闪光。资源延迟、缺失或特效池满时，准确攻击提示仍然可见。

装备分为武器、防具、护符和挂件：仅武器强化技能；13 件机关与 9 件旅途珍藏各有固定功能、取舍和独立物件图。普通非武器掉落改用固定珍藏，旧随机词条装备仍可读取。换装先比较，再保存并提交；生命按比例重算，不能靠循环换装回血，技能继承剩余冷却。物件 SVG 为本项目绘制，武器图继续使用原作素材。

星灯守望从 95 张扩充至 167 张伙伴卡，覆盖 39 部作品，全部使用精确原卡编号对应的完整卡面、模型、动作与技能特效。按名字、作品、战术和职业筛选；切换阵容保留卡片 DOM 与已解码图片。新增 72 张卡以五职业和共用战术规则组合会心、贯路、治疗护盾、弱化、易伤、守护等特色；说明与实装同源。收入、前排成本、治疗和首领抗控统一按战斗规则计算。五种设施图从各自原作模型渲染，训练机关诱饵与应援采集台使用不同模型与图标。

两作均有永久进化：五星伙伴需要 3 点同行阅历和 3 枚对应属性进化珠，四星需要各 2 点／枚。星灯守望战役胜利及无尽每完成 5 波，为编队伙伴增加阅历、为每种编队属性带回一枚进化珠；花笺旅记每次成功前往下一层或完成整卷时，为当前伙伴增加阅历和进化珠。进化在原有结算与存档事务内完成，生命提升 15%、攻击能力提升 12%（巡守中的治疗和护盾同样提升 12%）。进化后解锁原卡的新卡面、头像和模型，也可以切回旧外观而保留能力；未进化的新局使用基础形态，进化后卡面仍可预览。旧档不会凭外观自动获得能力，续档保留该局的进化状态。

进化依据为本地原作 `Star/EditUtility.cs` 的 `CanEvolution`／`SimulateEvolution` 与 `CharacterEvolutionList.json`：培养条件、对应素材、永久转换及保留已有成长。小游戏将原作的满突破／满级、金币和多种材料简化为同行阅历与单种属性珠；不复制原作等级上限变化，战斗角色编号保持稳定。材料图使用原编号，水／风素材顺序经过配方表核对。星灯守望默认展示 155 张五星和 2 张特殊换装四星，10 张普通四星仍可通过“全部（含旧版收藏）”使用；三十二关仍以未进化编队的真实部署预算验证。

共用成长面板分别展示阅历、属性珠、尚缺条件及真实能力前后对比。成功保存后展示原作双卡面与可跳过的过渡动画；短横屏改为并排布局，减少动态设置会关闭动画。

标题人物浮动、卡片入场与悬停、部署选择扫光、必杀就绪辉光随状态播放；暂停和“减少动态效果”设置会停止对应动画。手机竖屏编队固定出发按钮，矮横屏改为左右分栏，卡牌区域独立滚动。

两作使用本地原作音乐与配音；战斗 SE 为合成音效，本地没有原作 SE 音频库。音乐共用交叉渐变与暂停管理，音效限制同时声源并复用噪声缓冲；环境粒子、技能特效和弹道复用资源并在离场时释放。

怪物号令、咆哮、远射、挥击与退场使用各自音色，密集命中有全局限流。普通攻击与里程碑不再穿插无关必杀对白，首领转阶段也不再重复入场台词；原作必杀配音由对应演出时间线播放。

手机横竖屏、PC 窄窗口及矮窗口均可游玩。竖屏重新排列战场与触控区，转屏会清除未松开的输入并保留玩家手动暂停，不再强制锁定方向。完整卡图采用独立定高画框，避免图片固有尺寸撑开网格而裁切。记录保存在当前浏览器，沿用旧存档键，可通过各自的存档入口备份。

触控摇杆丢失捕获或被系统取消时立即释放；暂停、弹窗与恢复会清理旧手势和按键，系统连发不会复活已取消的移动。按住摇杆或攻击时，第二指仍可点击菜单和交互。

```sh
node tools/rl_roster_entry_harness.mjs
node tools/rl_story_harness.mjs
node tools/rl_save_harness.mjs
node tools/rl_terminal_harness.mjs
node tools/rl_equipment_skills_harness.mjs
node tools/rl_relics_harness.mjs
node tools/defense_companions_harness.mjs
node tools/card_forms_harness.mjs
node tools/adventure_evolution_harness.mjs
node tools/defense_balance_audit.mjs
node tools/rl_storage_harness.mjs
node tools/rl_boss_choreography_harness.mjs
node tools/rl_roomsize_harness.mjs
node tools/adventure_music_harness.mjs
npm test --prefix site/etowaria-defense
python tools/adventure_experience_browser.py --channel msedge
python tools/adventure_defense_browser.py
python tools/defense_expansion_browser.py
python tools/adventure_audio_browser.py
python tools/adventure_forms_browser.py
python tools/adventure_viewports_browser.py
python tools/rl_touch_lifecycle_browser.py
python tools/rl_native_blade_browser.py
python tools/rl_projectile_visual_browser.py
python tools/rl_hit_alignment_browser.py --all-classes
python tools/rl_hit_alignment_browser.py --missing
python tools/rl_boss_choreography_browser.py
python tools/rl_equipment_skills_browser.py
python tools/rl_roomsize_browser.py
python tools/rl_map_composition_browser.py
```

浏览器检查需要 Python Playwright 和已安装的 Edge；命中对齐脚本使用 Playwright Chromium，综合体验脚本不传 `--channel` 时也使用 Chromium。检查启动独立的无缓存本地服务和浏览器存档，覆盖桌面与手机选角、编队、开局、暂停、续玩、结算及横竖屏切换。截图与报告输出到 `.codex-tmp/` 下的 `adventure-review/`、`forms-review/`、`adaptive-review/`、`native-blades/`、`projectile-visual/`、`hit-alignment/`、`map-composition-audit/`、`defense-renewal/`、`adventure-audio/`、`boss-choreography/` 和 `feedback-20260910/`。适配检查覆盖 320×568 至 1440×900 的七种尺寸及真实触摸事件；原作剑／枪特效另有六属性、四方向共 48 个独立像素场景。

塔防浏览器验收使用独立的 `?review=1` 固定时钟；新角色演出夹具提供额外资源，经济与通关另由三十二关真实预算模拟验证。声音检查实际渲染 WebAudio 波形并播放本地音乐，验证峰值、切曲与释放。固定时钟检查不代表真实设备帧率测量。

素材重建：`python tools/defense_refresh_catalogue.py --card-art` 按原卡编号补齐卡图并刷新目录，`python tools/rl_equipment_art.py` 重建机关与珍藏 SVG；设施图来源记录在 `site/etowaria-defense/assets/items/sources.json`。

## 目录结构

```
index.html          倒计时器（data.js 维护活动数据）
site/               站点主体
  models.html       模型素材库（asset/models/，tools/build_model_catalog.py 重建）
  gacha.html        纪念召唤
  game/roguelike.html  动作 Roguelike 入口
  game/rl/          游戏逻辑、流程装配、DOM 界面和 three.js 渲染
  etowaria-defense/  星灯守望：战役界面、塔防规则、场景渲染与本地记录
  css/adventure.css 两款小游戏共享的纪念绘本视觉基础
  asset/            游戏资产：模型、战斗、卡池、城镇、停服纪念图等
  core/             加载器、音频、贴图修复等共享模块
tools/              资产转换与校验脚本（Unity bundle → glTF）
docs/               开发文档（仅本机保留，不入库）
```

倒计时器的数据格式（`data.js` 中 `timersData` 各事件类型与查询参数）沿用上游的约定，编辑方式与上游文档一致。
