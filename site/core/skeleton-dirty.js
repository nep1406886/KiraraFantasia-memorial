// Skip only genuinely unchanged skeletons. boneMatrices is OUTPUT, written
// by Skeleton.update itself: comparing it alone before update freezes every
// skin after its first upload, even while AnimationMixer moves the bones.
// The inputs are bone.matrixWorld and boneInverses, not the previous output.
// Keep THREE's implementation for every changed pose and texture/buffer swap.
// Snapshots are reused; animated frames do not allocate new typed arrays.
// tools/rl_skeleton_harness.mjs compares results against the vendored THREE.

export function installSkeletonDirtyGuard(THREE) {
    const proto = THREE.Skeleton && THREE.Skeleton.prototype;
    if (!proto || !proto.update || proto.__kfSkeletonDirtyGuard) {
        return false;
    }
    const snapshots = new WeakMap();
    const originalUpdate = proto.update;
    const identity = new THREE.Matrix4().elements;
    function unchanged(skeleton, snapshot) {
        if (!snapshot || snapshot.buffer !== skeleton.boneMatrices
                || snapshot.texture !== skeleton.boneTexture
                || snapshot.inputs.length !== skeleton.bones.length * 32) {
            return false;
        }
        for (let i = 0; i < skeleton.bones.length; i++) {
            const world = skeleton.bones[i] ? skeleton.bones[i].matrixWorld.elements : identity;
            const inverse = skeleton.boneInverses[i].elements;
            const offset = i * 32;
            for (let j = 0; j < 16; j++) {
                if (snapshot.inputs[offset + j] !== world[j]
                        || snapshot.inputs[offset + 16 + j] !== inverse[j]) {
                    return false;
                }
            }
        }
        // A caller may overwrite/reinitialize the output without moving bones.
        for (let i = 0; i < skeleton.boneMatrices.length; i++) {
            if (snapshot.output[i] !== skeleton.boneMatrices[i]) { return false; }
        }
        return true;
    }
    proto.__kfSkeletonDirtyGuard = true;
    proto.update = function () {
        let snapshot = snapshots.get(this);
        if (unchanged(this, snapshot)) { return; }
        originalUpdate.call(this);
        if (!snapshot || snapshot.inputs.length !== this.bones.length * 32
                || snapshot.output.length !== this.boneMatrices.length) {
            snapshot = { inputs: new Float64Array(this.bones.length * 32),
                output: new Float32Array(this.boneMatrices.length) };
            snapshots.set(this, snapshot);
        }
        for (let i = 0; i < this.bones.length; i++) {
            snapshot.inputs.set(this.bones[i] ? this.bones[i].matrixWorld.elements : identity, i * 32);
            snapshot.inputs.set(this.boneInverses[i].elements, i * 32 + 16);
        }
        snapshot.output.set(this.boneMatrices);
        snapshot.buffer = this.boneMatrices;
        snapshot.texture = this.boneTexture;
    };
    return true;
}
