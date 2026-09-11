// T22m billboard tilt: the character models are 2.5D paper stacks exported
// front-on (the observation room views them with a straight-on camera), but
// the game camera looks down a ~54° pitch. A vertical paper stack under that
// camera is foreshortened and shows its layer spacing edge-on — the "body
// and limbs look wrong" the user measured against the observation room. The
// fix is what every billboard does: rotate the stack around its feet so its
// front is perpendicular to the view ray. The on-screen result is then the
// observation room's straight-on read, anchored to the ground by the contact
// shadow.
//
// The pitch is not constant — the T22b camera-height slider retunes the rig
// (40–63°) — so main.js's syncViews publishes the live pitch here every
// frame, BEFORE any view syncs. Views that never receive a publish (a bare
// harness driving one view) read 0 and keep the old upright behaviour.

let pitch = 0;

export function setCharacterPitch(radians) {
    pitch = Number(radians) || 0;
}

// rotation.x for a south-facing stack: rotation.x = -pitch leans the top
// back toward the camera (front +z maps to (0, sin p, cos p)).
export function characterTiltX() {
    return -pitch;
}
