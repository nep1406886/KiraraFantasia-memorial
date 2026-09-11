// Authored player mesh switches (legs, hats and alternate silhouettes).
// These are discrete animation tracks, not materials or facial expressions.
let tablePromise = null;

export function loadPlayerVisibility(url) {
    if (!tablePromise) {
        tablePromise = fetch(url).then(response => {
            if (!response.ok) { throw new Error("player visibility " + response.status); }
            return response.json();
        }).catch(() => null);
    }
    return tablePromise;
}

function variantSet(name) {
    const key = String(name).toLowerCase();
    return /^(leg_[lr]|hat)_/.exec(key)?.[1] || key;
}

function valueAt(track, frame) {
    if (!Array.isArray(track)) { return !!track; }
    let value = track.length ? track[0][1] : 1;
    for (const key of track) {
        if (key[0] > frame) { break; }
        value = key[1];
    }
    return value === 1;
}

export function createPlayerVisibility(root, table, classId, nodeName) {
    const nodes = new Map(), sets = new Map();
    const governed = new Map((table?.nodes || []).map(name => [name.toLowerCase(), name]));
    root.traverse(node => {
        const name = governed.get(String(nodeName(node) || "").toLowerCase());
        if (!node.isMesh || !name) { return; }
        if (!nodes.has(name)) { nodes.set(name, []); }
        nodes.get(name).push(node);
        const set = variantSet(name);
        sets.set(set, (sets.get(set) || 0) + 1);
        node.userData.visibilityGoverned = true;
    });
    let tracks = null, lastFrame = -1;
    function update(seconds) {
        if (!tracks) { return; }
        const frame = Math.floor(Math.max(0, seconds) * (table.fps || 30) + 1e-7);
        if (frame === lastFrame) { return; }
        lastFrame = frame;
        for (const [name, track] of Object.entries(tracks)) {
            const visible = sets.get(variantSet(name)) < 2 || valueAt(track, frame);
            for (const node of nodes.get(name) || []) { node.visible = visible; }
        }
    }
    function select(name, sourceClass = classId) {
        const next = table?.classClips?.[sourceClass]?.[name] || table?.clips?.[name];
        // Unknown cinematic clips retain the previous authored silhouette.
        if (!next) { return false; }
        tracks = next;
        lastFrame = -1;
        update(0);
        return true;
    }
    for (const name of ["room_idle_L", "idle", "battle_run"]) {
        if (select(name)) { break; }
    }
    return { select, update };
}
