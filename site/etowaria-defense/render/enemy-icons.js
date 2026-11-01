// 来客小像：拍「池内来客模型本体」，不是手绘近似，也不做 clone。
// 来客是 SkinnedMesh（native-model.js 的加载路径），vendor three 没有
// SkeletonUtils，object.clone(true) 得到的副本会与场上原件共享骨架，
// 行走姿势会渗进拍摄瞬间——所以这里把池内模型整只挪进独立拍摄 scene，
// mixer 暂停定帧，拍完原样放回。
// three 与拍摄管线都在拍摄函数内部按需动态导入：来客页签只在战斗中
// 打开，那一刻 battle-view/stage 早已加载，动态导入零额外成本；选关图
// 载入本模块也不会把 3D 栈提前拖进内存。
import { ENEMY_RULES } from "../data/campaign.js";

const SIZE = 96; // 44px 显示格的 2x 采样，单张 PNG 仍在几 KB 量级
const STORE_KEY = "etowaria-defense.enemyicons.v1";

export function loadEnemyIcons() {
    try { return JSON.parse(localStorage.getItem(STORE_KEY)) || {}; }
    catch { return {}; }
}

export function storeEnemyIcons(icons) {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(icons)); }
    catch { /* 配额不足：只保留内存副本，同一会话内仍然秒出 */ }
}

// 拍一张：借池内模型 → 挪进独立 scene → mixer 暂停定帧 → 正交机位渲染。
// 借来的模型拍完原样放回池里；池空时临时补建的模型拍完立即释放，
// 显存回落到拍摄前的水位。池的补建走 view.loadEnemy——战斗出场本就
// 走同一条路，不另开加载通道。
// size 可选：默认仍拍 SIZE（96px，网格缩略）；图鉴大图页传 288 现拍
// 高清留影，不落 STORE_KEY，避免 localStorage 膨胀。
export async function captureEnemyIcon(view, type, size = SIZE) {
    const spec = ENEMY_RULES[type];
    if (!spec || !view?.stage) { return null; }
    const stage = view.stage;
    let model = view.enemyPools.get(type)?.pop() || null;
    const borrowed = !!model;
    if (!model) {
        await view.loadEnemy(type);
        model = view.enemyPools.get(type)?.pop() || null;
    }
    if (!model || view.disposed || !view.stage) { return null; }
    const THREE = stage.THREE;
    const { posedBounds, PITCH } = await import("./native-model.js");
    const { withCaptureTarget } = await import("./capture.js");
    const scene = new THREE.Scene();
    scene.add(model.group);
    const prevPosition = model.group.position.clone();
    const prevTimeScale = model.mixer.timeScale;
    let url = null;
    try {
        // 池内模型可能带着退休前的落点，拍摄位一律归零。
        model.group.position.set(0, 0, 0);
        // mixer 暂停 + 定帧站立姿势：池内模型本就没有别的更新者，
        // 这里再上双保险，拍摄期间姿势绝不漂移。
        model.mixer.timeScale = 0;
        model.play("idle");
        model.mixer.update(0);
        const bounds = posedBounds(THREE, model.root);
        const center = bounds.getCenter(new THREE.Vector3());
        const extent = bounds.getSize(new THREE.Vector3());
        const half = Math.max(extent.x, extent.y) * .68;
        const camera = new THREE.OrthographicCamera(-half, half, half, -half, .01, 80);
        // 与战场同一俯角（PITCH）：小像和场上看到的身形一致。
        camera.position.set(center.x, center.y + Math.sin(PITCH) * 20, center.z + Math.cos(PITCH) * 20);
        camera.lookAt(center);
        url = withCaptureTarget(THREE, stage.renderer, size, size, () => stage.renderer.render(scene, camera));
    } finally {
        // 放回并清理：借来的原样归池；临时补建的摘出 allModels 后释放。
        model.group.position.copy(prevPosition);
        model.group.removeFromParent();
        model.mixer.timeScale = prevTimeScale;
        if (borrowed) { view.enemyPools.get(type)?.push(model); }
        else { view.allModels.delete(model); model.dispose(); }
    }
    return url;
}
