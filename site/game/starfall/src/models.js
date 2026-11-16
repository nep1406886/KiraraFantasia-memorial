// The 3D character layer. The world is painted in 2D; the cast is the original
// game's paper-stack chibi models, rendered by an orthographic camera that maps
// one unit to one design pixel. Game code only ever sees a small handle with
// move(), play() and mirror().

import * as THREE from "three";
import * as loader from "../../../core/loader.js";
import * as actorlib from "../../../core/actor.js";

export const PLAYER_HEIGHT = 98;

function disposeScene(scene) {
  if (!scene) return;
  scene.removeFromParent?.();
  try { loader.disposeObject(scene); } catch (error) { console.warn("starfall model dispose:", error); }
}

function setShadows(root) {
  root.traverse(node => {
    if (!node.isMesh) return;
    node.castShadow = false;
    node.receiveShadow = false;
    node.frustumCulled = false;
  });
}

export class ModelHandle {
  constructor(root, { height = 60, x = 0, groundY = 0, facing = 1, kind = "enemy" } = {}) {
    this.kind = kind;
    this.inner = root;
    this.outer = new THREE.Group();
    this.outer.add(root);
    this.outer.position.set(x, -groundY, groundY * 0.01);
    this.facing = facing;
    this.scaleMul = 1;
    this.height = height;
    this.groundY = groundY;
    this.visible = true;

    const box = new THREE.Box3().setFromObject(root);
    const size = box.getSize(new THREE.Vector3());
    const vertical = Math.max(0.001, size.y);
    const scale = height / vertical;
    root.scale.multiplyScalar(scale);
    // The authored root is the character's feet/origin. Keep x at the origin so
    // a shield or greatsword sticking out to one side does not shift the body
    // away from the collision box.
    root.position.x = 0;
    root.position.z = 0;
    root.position.y = 0;
    this.outer.scale.set(facing, 1, 1);
    setShadows(root);
  }

  move(x, groundY) {
    this.outer.position.x = x;
    this.outer.position.y = -groundY;
    this.outer.position.z = groundY * 0.01;
    this.groundY = groundY;
  }

  mirror(facing) {
    const next = facing < 0 ? -1 : 1;
    if (next === this.facing) return;
    this.facing = next;
    this.outer.scale.x = next * this.scaleMul;
  }

  setScale(mul) {
    this.scaleMul = mul;
    this.outer.scale.set(this.facing * mul, mul, mul);
  }

  setVisible(visible) {
    this.visible = !!visible;
    this.outer.visible = this.visible;
  }

  setTilt(angle) {
    this.outer.rotation.z = angle;
  }

  setOpacity() { /* original materials are alpha-authored; fade is done with 2D FX */ }

  update() {}
  play() { return false; }
  destroy() {
    disposeScene(this.inner);
    this.outer.removeFromParent();
  }
}

class EnemyHandle extends ModelHandle {
  constructor(root, animations, opts) {
    super(root, opts);
    this.mixer = new THREE.AnimationMixer(root);
    this.clips = new Map();
    (animations || []).forEach(clip => this.clips.set(clip.name, clip));
    this.current = null;
    this.currentName = "";
    this.finishedAt = 0;
    this.play("idle", { loop: true, fade: 0 });
  }

  play(name, { loop = true, fade = 0.12, speed = 1 } = {}) {
    const clip = this.clips.get(name) || this.clips.get("idle");
    if (!clip) return false;
    const action = this.mixer.clipAction(clip);
    if (this.current === action && action.isRunning()) {
      action.setEffectiveTimeScale(speed);
      return true;
    }
    if (this.current && this.current !== action) this.current.fadeOut(fade);
    action.reset();
    action.setLoop(loop ? THREE.LoopRepeat : THREE.LoopOnce, loop ? Infinity : 1);
    action.clampWhenFinished = !loop;
    action.setEffectiveTimeScale(speed);
    action.fadeIn(fade);
    action.play();
    this.current = action;
    this.currentName = clip.name;
    return true;
  }

  update(dt) {
    this.mixer.update(dt);
    if (this.current && this.currentName !== "dead" && this.currentName !== "idle") {
      const clip = this.current.getClip();
      if (this.current.time >= clip.duration - 0.04) {
        this.play("idle", { loop: true, fade: 0.16 });
      }
    }
  }
}

class PlayerHandle extends ModelHandle {
  constructor(actor, opts) {
    super(actor.object, opts);
    this.actor = actor;
    this.current = "";
    this.actor.play("idle", { fade: 0 });
    this.current = "idle";
  }

  play(name, { loop = true, duration = 0, speed = 1, fade = 0.12 } = {}) {
    if (!this.actor) return false;
    const accepted = this.actor.play(name, { loop, duration, speed, fade });
    if (accepted) this.current = name;
    return accepted;
  }

  face(name) {
    this.actor?.face(name);
  }

  update(dt) {
    this.actor?.update(dt);
  }

  destroy() {
    try { this.actor?.dispose(); } catch (error) { console.warn("starfall actor dispose:", error); }
    this.outer.removeFromParent();
  }
}

export class Stage3D {
  constructor(canvas) {
    this.canvas = canvas;
    this.width = 960;
    this.height = 540;
    this.ok = false;
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      alpha: true,
      antialias: true,
      premultipliedAlpha: false,
      powerPreference: "high-performance"
    });
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.setPixelRatio(1);
    this.scene = new THREE.Scene();
    this.camera = new THREE.OrthographicCamera(0, 960, 0, -540, 0.1, 900);
    this.camera.position.set(0, 0, 100);
    this.camera.rotation.set(0, 0, 0);
    this.scene.add(new THREE.HemisphereLight(0xfff5e6, 0x4b3a68, 2.15));
    const key = new THREE.DirectionalLight(0xfff0d4, 1.65);
    key.position.set(-4, 6, 7);
    this.scene.add(key);
    const rim = new THREE.DirectionalLight(0xb9a2ff, 0.9);
    rim.position.set(5, 2, 4);
    this.scene.add(rim);
    const fill = new THREE.DirectionalLight(0xa8d8ff, 0.45);
    fill.position.set(3, -4, 5);
    this.scene.add(fill);
    this.clock = new THREE.Clock();
    this.handles = new Set();
    this.player = null;
    this.ok = true;
    this.resize(960, 540, 1);
  }

  resize(width, height, pixelRatio = 1) {
    this.width = width;
    this.height = height;
    const w = Math.max(1, Math.round(width * pixelRatio));
    const h = Math.max(1, Math.round(height * pixelRatio));
    this.renderer.setPixelRatio(1);
    this.renderer.setSize(w, h, false);
    this.camera.left = 0;
    this.camera.right = width;
    this.camera.top = 0;
    this.camera.bottom = -height;
    this.camera.updateProjectionMatrix();
  }

  async addPlayer(character, { onProgress } = {}) {
    const actor = await actorlib.create({
      resourceId: character.resourceId,
      classId: character.classId,
      headId: 0,
      weapon: "default",
      onProgress
    });
    const handle = new PlayerHandle(actor, {
      height: PLAYER_HEIGHT,
      x: 0,
      groundY: 438,
      facing: 1,
      kind: "player"
    });
    this.scene.add(handle.outer);
    this.handles.add(handle);
    this.player = handle;
    return handle;
  }

  async addEnemy(modelId, opts = {}) {
    const loaded = await loader.load("model/enemy/model_en_" + modelId + ".muast", { kind: "enemy" });
    const handle = new EnemyHandle(loaded.scene, loaded.animations, {
      height: opts.height || 50,
      x: opts.x || 0,
      groundY: opts.groundY || 438,
      facing: opts.facing || 1,
      kind: "enemy"
    });
    if (opts.scale) handle.setScale(opts.scale);
    this.scene.add(handle.outer);
    this.handles.add(handle);
    return handle;
  }

  addFallback(x, groundY, facing) {
    const group = new THREE.Group();
    const body = new THREE.Mesh(
      new THREE.CapsuleGeometry(9, 44, 4, 12),
      new THREE.MeshBasicMaterial({ color: 0xf0b7c8 })
    );
    body.position.y = -54;
    group.add(body);
    const neck = new THREE.Mesh(
      new THREE.SphereGeometry(11, 16, 12),
      new THREE.MeshBasicMaterial({ color: 0xffe5d1 })
    );
    neck.position.y = -84;
    group.add(neck);
    const handle = new ModelHandle(group, { height: 98, x, groundY, facing, kind: "player" });
    this.scene.add(handle.outer);
    this.handles.add(handle);
    this.player = handle;
    return handle;
  }

  remove(handle) {
    if (!handle) return;
    this.handles.delete(handle);
    if (this.player === handle) this.player = null;
    handle.destroy();
  }

  clearEnemies() {
    for (const handle of Array.from(this.handles)) {
      if (handle.kind !== "player") this.remove(handle);
    }
  }

  clearAll() {
    for (const handle of Array.from(this.handles)) this.remove(handle);
    this.player = null;
  }

  render(camX = 0, camY = 0, shakeX = 0, shakeY = 0) {
    this.camera.position.set(camX + shakeX, -camY - shakeY, 100);
    this.renderer.render(this.scene, this.camera);
  }

  setAnimationClock(seconds) {
    this.elapsed = seconds;
  }
}

export function enemyModelUrl() {
  return "";
}
