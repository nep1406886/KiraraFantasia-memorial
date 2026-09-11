import * as THREE from "./vendor/three/three.module.min.js";
import { GLTFLoader } from "./vendor/three/GLTFLoader.js";

const MODEL_URL = "imgs/gacha/gacha_key_official.glb";

export function initGachaKeyRenderer() {
    const canvas = document.getElementById("summonKeyCanvas");
    const sequence = canvas && canvas.closest(".summon-key-sequence");
    if (!canvas || !sequence || !window.WebGLRenderingContext) {
        return Promise.resolve(null);
    }

    let renderer;
    try {
        renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true, powerPreference: "high-performance" });
    } catch (error) {
        return Promise.resolve(null);
    }

    renderer.setClearColor(0x000000, 0);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
    renderer.outputColorSpace = THREE.SRGBColorSpace;

    const scene = new THREE.Scene();
    const camera = new THREE.OrthographicCamera(-4, 4, 2.25, -2.25, 0.1, 40);
    camera.position.set(0, 0, 12);
    camera.lookAt(0, 0, 0);
    scene.add(new THREE.HemisphereLight(0xffffff, 0x6f4318, 2.8));
    const keyLight = new THREE.DirectionalLight(0xfff0ba, 4.4);
    keyLight.position.set(-2, 3, 6);
    scene.add(keyLight);
    const keyFillLight = new THREE.PointLight(0xffc84f, 2.2, 18);
    keyFillLight.position.set(2, -1, 6);
    scene.add(keyFillLight);

    const pivot = new THREE.Group();
    pivot.visible = false;
    scene.add(pivot);

    function keyQuaternion(x, y, z, w) {
        return new THREE.Quaternion(x, y, z, w).normalize();
    }

    // Converted from the official Unity Gacha@start clip. The GLB exporter
    // mirrors Unity's X axis, so (x, y, z, w) becomes (x, -y, -z, w).
    const sideQuaternion = keyQuaternion(0.5, -0.5, -0.5, 0.5);
    const flightRotationFrames = [
        { time: 0, value: keyQuaternion(0.719542, -0.679948, -0.044858, -0.133858) },
        { time: 833.3, value: keyQuaternion(0.747526, -0.619836, -0.213293, 0.107308) },
        { time: 1366.7, value: keyQuaternion(0.503264, -0.501218, -0.497737, 0.497758) },
        { time: 1400, value: sideQuaternion }
    ];
    const flightPositionFrames = [
        { time: 0, value: new THREE.Vector3(-5.899, -0.751, 0) },
        { time: 833.3, value: new THREE.Vector3(-2.277, -0.202, 0) },
        { time: 1366.7, value: new THREE.Vector3(-0.0118, 0.416, 0) },
        { time: 1400, value: new THREE.Vector3(0, 0.42, 0) }
    ];
    const lockRotationFrames = [
        { time: 0, value: sideQuaternion },
        { time: 766.7, value: keyQuaternion(0.058232, -0.704705, -0.704705, 0.058232) },
        { time: 1066.7, value: keyQuaternion(0.020031, -0.706823, -0.706823, 0.020031) },
        { time: 1866.7, value: keyQuaternion(0.009126, -0.707048, -0.707048, 0.009126) }
    ];
    const finalQuaternion = lockRotationFrames[lockRotationFrames.length - 1].value;
    const positionScratch = new THREE.Vector3();

    let phase = "";
    let phaseStartedAt = 0;
    let frameId = 0;
    let disposed = false;

    function resize() {
        const width = Math.max(1, sequence.clientWidth);
        const height = Math.max(1, sequence.clientHeight);
        const aspect = width / height;
        const halfHeight = 2.25;
        camera.left = -halfHeight * aspect;
        camera.right = halfHeight * aspect;
        camera.top = halfHeight;
        camera.bottom = -halfHeight;
        camera.updateProjectionMatrix();
        renderer.setSize(width, height, false);
    }

    function easeOutCubic(value) {
        return 1 - Math.pow(1 - value, 3);
    }

    function smoothStep(value) {
        return value * value * (3 - 2 * value);
    }

    function clamp(value) {
        return Math.max(0, Math.min(1, value));
    }

    function frameSegment(elapsed, frames) {
        for (let index = 1; index < frames.length; index += 1) {
            if (elapsed <= frames[index].time) {
                return [frames[index - 1], frames[index]];
            }
        }
        return [frames[frames.length - 1], frames[frames.length - 1]];
    }

    function trackProgress(elapsed, start, end) {
        if (end.time === start.time) {
            return 1;
        }
        return smoothStep(clamp((elapsed - start.time) / (end.time - start.time)));
    }

    function applyQuaternionTrack(elapsed, frames) {
        const [start, end] = frameSegment(elapsed, frames);
        pivot.quaternion.slerpQuaternions(start.value, end.value, trackProgress(elapsed, start, end));
    }

    function applyPositionTrack(elapsed, frames) {
        const [start, end] = frameSegment(elapsed, frames);
        positionScratch.lerpVectors(start.value, end.value, trackProgress(elapsed, start, end));
        pivot.position.copy(positionScratch);
    }

    function applyInsertionPosition(elapsed) {
        if (elapsed <= 150) {
            pivot.position.set(0, 0.42, 0);
            return;
        }
        if (elapsed <= 350) {
            const progress = smoothStep((elapsed - 150) / 200);
            pivot.position.set(0, THREE.MathUtils.lerp(0.42, -0.25, progress), 0);
            return;
        }
        if (elapsed <= 650) {
            const progress = easeOutCubic((elapsed - 350) / 300);
            pivot.position.set(0, THREE.MathUtils.lerp(-0.25, -0.08, progress), 0);
            return;
        }
        pivot.position.set(0, -0.08, 0);
    }

    function setTransform(now) {
        const elapsed = now - phaseStartedAt;
        if (phase === "phase-key-flight") {
            const progress = easeOutCubic(clamp(elapsed / 1400));
            pivot.visible = true;
            applyPositionTrack(elapsed, flightPositionFrames);
            applyQuaternionTrack(elapsed, flightRotationFrames);
            pivot.scale.setScalar(THREE.MathUtils.lerp(0.62, 1.02, progress));
            return;
        }
        if (phase === "phase-key-focus") {
            pivot.visible = true;
            applyInsertionPosition(elapsed);
            pivot.quaternion.copy(sideQuaternion);
            pivot.scale.setScalar(1.02);
            return;
        }
        if (phase === "phase-key-lock") {
            pivot.visible = true;
            pivot.position.set(0, -0.08, 0);
            applyQuaternionTrack(elapsed, lockRotationFrames);
            pivot.scale.setScalar(1.02);
            return;
        }
        if (phase === "phase-key-flash") {
            pivot.visible = true;
            pivot.position.set(0, -0.08, 0);
            pivot.quaternion.copy(finalQuaternion);
            pivot.scale.setScalar(1.02);
            return;
        }
        pivot.visible = false;
    }

    function render(now) {
        frameId = 0;
        if (disposed) {
            return;
        }
        setTransform(now);
        renderer.render(scene, camera);
        if (phase) {
            frameId = window.requestAnimationFrame(render);
        }
    }

    function setPhase(nextPhase) {
        if (phase === nextPhase) {
            return;
        }
        phase = nextPhase;
        phaseStartedAt = performance.now();
        if (!frameId && !disposed) {
            frameId = window.requestAnimationFrame(render);
        }
    }

    const resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(sequence);
    resize();

    return new Promise(function (resolve) {
        new GLTFLoader().load(MODEL_URL, function (gltf) {
            const model = gltf.scene;
            const bounds = new THREE.Box3().setFromObject(model);
            const center = bounds.getCenter(new THREE.Vector3());
            const size = bounds.getSize(new THREE.Vector3());
            const longestSide = Math.max(size.x, size.y, size.z) || 1;
            model.position.sub(center);
            // The official clip renders the depth-facing key as a broad flower
            // silhouette. Keep the model's proportions and match that screen size
            // through one uniform normalization value.
            model.scale.setScalar(4.6 / longestSide);
            model.traverse(function (object) {
                if (!object.isMesh) {
                    return;
                }
                object.frustumCulled = false;
                if (object.material && object.material.map) {
                    object.material.map.colorSpace = THREE.SRGBColorSpace;
                }
            });
            pivot.add(model);
            sequence.classList.add("key-3d-ready");
            resolve({
                setPhase,
                dispose: function () {
                    disposed = true;
                    if (frameId) {
                        window.cancelAnimationFrame(frameId);
                    }
                    resizeObserver.disconnect();
                    renderer.dispose();
                }
            });
        }, undefined, function () {
            renderer.dispose();
            resizeObserver.disconnect();
            resolve(null);
        });
    });
}
