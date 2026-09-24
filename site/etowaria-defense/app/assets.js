import * as modelLoader from "../../core/loader.js";

const SITE = new URL("../../", import.meta.url);
const DATA = new URL("../data/", import.meta.url);
const jsonCache = new Map();
let runtimePromise;
let installedManifest;

export const siteUrl = path => new URL(path.replace(/^\//, ""), SITE).href;
export const uiUrl = name => new URL(`../assets/ui/${name}.png`, import.meta.url).href;
export const classIcons = ["Fighter", "Magician", "Priest", "Knight", "Alchemist"];
export const elementIcons = ["Fire", "Water", "Earth", "Wind", "Moon", "Sun"];
export const elementKeys = ["fire", "water", "earth", "wind", "moon", "sun"];

export function readJson(url) {
    const key = String(url);
    if (!jsonCache.has(key)) {
        const promise = fetch(key).then(response => {
            if (!response.ok) { throw new Error(`资料读取失败（${response.status}）：${new URL(key).pathname}`); }
            return response.json();
        }).catch(error => {
            jsonCache.delete(key);
            throw error;
        });
        jsonCache.set(key, promise);
    }
    return jsonCache.get(key);
}

export const loadCatalogue = () => readJson(new URL("units.json", DATA));

export function loadRuntimeAssets() {
    if (!runtimePromise) {
        runtimePromise = Promise.all([
            readJson(new URL("models.json", DATA)),
            readJson(new URL("native.json", DATA)),
            readJson(new URL("room-assets.json", DATA)),
            readJson(new URL("playback.json", DATA)),
            import("../../vendor/three/three.module.min.js"),
            import("../../vendor/three/GLTFLoader.js"),
            import("../../vendor/three/meshopt_decoder.module.js")
        ]).then(async ([manifest, native, rooms, playback]) => {
            if (!installedManifest) {
                modelLoader.installManifest(manifest);
                installedManifest = manifest;
            }
            const modules = await modelLoader.loadModules();
            return { ...modules, native, rooms, playback, manifest: installedManifest };
        }).catch(error => {
            runtimePromise = null;
            throw error;
        });
    }
    return runtimePromise;
}

export async function loadActionPack(file, meshopt = false) {
    const { GLTFLoader, MeshoptDecoder } = await modelLoader.loadModules();
    const blob = await modelLoader.readModelCached(siteUrl(file), "gzip");
    const loader = new GLTFLoader();
    if (meshopt) { loader.setMeshoptDecoder(MeshoptDecoder); }
    return loader.parseAsync(await blob.arrayBuffer(), "");
}

export function portraitMarkup(unit, options = {}) {
    const element = document.createElement("span");
    element.className = "portrait-icon";
    const images = [
        ["face", siteUrl(unit.icon), unit.name],
        ["frame", uiUrl("CharaIconFrame05"), ""]
    ];
    if (options.identity !== false) {
        images.push(["class-icon", uiUrl(`ClassIcon${classIcons[unit.classId]}`), unit.className]);
        images.push(["element-icon", uiUrl(`ElementIcon${elementIcons[unit.elementId]}`), unit.elementName]);
    }
    for (const [className, src, alt] of images) {
        const image = document.createElement("img");
        image.className = className;
        image.src = src;
        image.alt = alt;
        image.draggable = false;
        element.append(image);
    }
    return element;
}
