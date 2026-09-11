// Exercise the shipped THREE implementation, not a mock of its matrix update.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

async function moduleFrom(path) {
    const source = await readFile(new URL(path, import.meta.url), 'utf8');
    return import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
}
const THREE = await moduleFrom('../site/vendor/three/three.core.min.js');
const { installSkeletonDirtyGuard } = await moduleFrom('../site/core/skeleton-dirty.js');
const original = THREE.Skeleton.prototype.update;
assert.equal(installSkeletonDirtyGuard(THREE), true);
assert.equal(installSkeletonDirtyGuard(THREE), false);

const root = new THREE.Group();
const parent = new THREE.Bone(), child = new THREE.Bone();
root.add(parent); parent.add(child); child.position.y = 2;
root.updateMatrixWorld(true);
const actual = new THREE.Skeleton([parent, child]);
const reference = new THREE.Skeleton([parent, child]);
actual.computeBoneTexture(); reference.computeBoneTexture();

let checks = 0;
function verify(label) {
    root.updateMatrixWorld(true);
    actual.update(); original.call(reference);
    assert.deepEqual([...actual.boneMatrices], [...reference.boneMatrices], label);
    checks++;
}
verify('initial bind pose');
const initialVersion = actual.boneTexture.version;
for (let i = 0; i < 120; i++) verify('unchanged pose');
assert.equal(actual.boneTexture.version, initialVersion, 'static pose must not upload again');

parent.position.x = 3;
verify('a moving bone must reach the GPU after the first frame');
assert.equal(actual.boneMatrices[12], 3);
assert.ok(actual.boneTexture.version > initialVersion);
for (let i = 0; i < 90; i++) {
    parent.rotation.z = i / 45;
    child.position.x = Math.sin(i / 8);
    root.position.set(i * .13, 0, i * -.07);
    root.scale.x = i < 45 ? 2 : -2;
    verify('animation, world motion and negative scale ' + i);
}

actual.boneInverses[1].elements[13] -= .75;
reference.boneInverses[1].elements[13] -= .75;
verify('changed inverse bind matrix');
actual.boneMatrices.fill(123, 0, actual.bones.length * 16);
verify('externally overwritten output must be restored');
actual.boneMatrices = new Float32Array(actual.boneMatrices.length);
verify('replaced output buffer');
actual.dispose(); actual.computeBoneTexture();
verify('new texture after dispose');
assert.ok(actual.boneTexture.version >= 2, 'new texture receives a complete pose');

const beforePause = actual.boneTexture.version;
for (let i = 0; i < 120; i++) verify('paused animated pose');
assert.equal(actual.boneTexture.version, beforePause);
actual.bones[1] = null; reference.bones[1] = null;
verify('missing bone uses upstream identity behavior');
const childInverse = actual.boneInverses[1].clone();
actual.bones.push(child); reference.bones.push(child);
actual.boneInverses.push(childInverse); reference.boneInverses.push(childInverse.clone());
actual.init(); reference.init();
actual.computeBoneTexture(); reference.computeBoneTexture();
verify('changed bone count');

const noTexture = new THREE.Skeleton([parent]);
noTexture.update(); parent.position.y += .5; root.updateMatrixWorld(true); noTexture.update();
const expected = new THREE.Skeleton([parent], noTexture.boneInverses.map(m => m.clone()));
original.call(expected);
assert.deepEqual([...noTexture.boneMatrices], [...expected.boneMatrices], 'CPU-only skinning stays current');
actual.dispose(); reference.dispose(); noTexture.dispose();
console.log('PASS ' + checks + ' exact comparisons with upstream Skeleton.update; moving skins update, paused skins avoid uploads');
