// Per-unit state machines for the roguelike logic layer (master plan §4.2).
//
// A unit's state is plain data the world computes with; the view layer maps it
// to animation clips elsewhere (view/actorview.js). Nothing here may touch
// three.js or the DOM.
//
// Timing constants are the game feel numbers for stage 1. Real stat tables
// arrive with the data pipeline (stage 3, spec/04); until then these are the
// only tuning knobs and they live in exactly one place.

export const PLAYER_TIMING = {
    moveSpeed: 3.5,          // world units per second
    attackDuration: 0.5,     // total swing time
    attackHitStart: 0.12,    // hit window opens (seconds into the swing)
    attackHitEnd: 0.30,      // hit window closes
    attackRange: 1.6,        // reach measured to the target's body edge
    attackArc: 100 * Math.PI / 180,  // full arc width
    attackCooldown: 0.12,    // actionable again this long before the swing ends
    inputBuffer: 0.18,       // one recent intent, never an unbounded action queue
    dodgeCancel: 0.22,       // can cancel a swing's recovery, not its wind-up
    dodgeDuration: 0.45,
    dodgeIframes: 0.35,      // 游玩说明: K/Space 闪避 0.35s 无敌
    dodgeSpeedMult: 2.4,     // dodge = a burst, not a different walk
    hitDuration: 0.30,
    hitInvuln: 0.60          // brief mercy after taking a hit
};

export const ENEMY_TIMING = {
    damageFlinch: 0.35,      // enemy "damage" state duration
    contactCooldown: 0.8,    // per-enemy gap between contact hits on the player
    // Stage 3 (plan §2.1): enemies do not walk, so their language is
    // telegraph → act. The telegraph is the player's dodge window and is
    // deliberately longer than the dodge (0.45s) so a read always beats a
    // reflex.
    telegraph: 0.70,
    skill: 0.45,             // the skill_0 / skill_1 clip window
    dash: 0.32,              // charger lunge travel
    recover: 0.40            // post-lunge vulnerability
};

// exits: which states may interrupt this one (same state re-enters, resetting
// its timer). next: state to fall into when duration elapses. duration 0 means
// the state persists until something else changes it.
export const PLAYER_STATES = {
    idle: { duration: 0, exits: ["move", "attack", "dodge", "hit", "dead"] },
    move: { duration: 0, exits: ["idle", "attack", "dodge", "hit", "dead"] },
    attack: { duration: PLAYER_TIMING.attackDuration - PLAYER_TIMING.attackCooldown, exits: ["hit", "dodge", "dead"], next: "idle" },
    dodge: { duration: PLAYER_TIMING.dodgeDuration, exits: ["dead"], next: "idle" },
    hit: { duration: PLAYER_TIMING.hitDuration, exits: ["dead"], next: "idle" },
    dead: { duration: 0, exits: [] }
};

export const ENEMY_STATES = {
    idle: { duration: 0, exits: ["telegraph", "damage", "dead"] },
    telegraph: { duration: ENEMY_TIMING.telegraph, exits: ["damage", "dead"], next: "skill" },
    // "skill" is the frame the committed action opens on; a charger's action is
    // the lunge, so it must be able to leave here for "dash" (enemyai.js
    // startDash). Without that edge the state is unreachable and the lunge is
    // silently dropped -- gated by tools/rl_enemy_harness.mjs.
    skill: { duration: ENEMY_TIMING.skill, exits: ["dash", "damage", "dead"], next: "idle" },
    dash: { duration: ENEMY_TIMING.dash, exits: ["damage", "dead"], next: "recover" },
    recover: { duration: ENEMY_TIMING.recover, exits: ["telegraph", "damage", "dead"], next: "idle" },
    damage: { duration: ENEMY_TIMING.damageFlinch, exits: ["damage", "dead"], next: "idle" },
    dead: { duration: 0, exits: [] }
};

// Bosses use the same states but never flinch: the player's swing cadence
// (~0.62s) is shorter than the flinch (0.35s), so a flinching boss could be
// stunlocked out of every telegraph by one attacker. Damage still shows -- the
// view flashes on the "hit" event -- it just does not interrupt.
export const BOSS_STATES = {
    idle: { duration: 0, exits: ["telegraph", "dead"] },
    telegraph: { duration: ENEMY_TIMING.telegraph, exits: ["dead"], next: "skill" },
    skill: { duration: ENEMY_TIMING.skill, exits: ["dash", "dead"], next: "idle" },
    dash: { duration: ENEMY_TIMING.dash, exits: ["dead"], next: "recover" },
    recover: { duration: ENEMY_TIMING.recover, exits: ["telegraph", "dead"], next: "idle" },
    dead: { duration: 0, exits: [] }
};


export function createStateMachine(initial, table) {
    let state = initial;
    let stateTime = 0;

    const machine = {
        get state() { return state; },
        get stateTime() { return stateTime; },
        // True once a timed state has run its full duration (checked before
        // the auto-transition, so the world can read "finished" on the same
        // tick the transition would happen).
        get finished() {
            const def = table[state];
            return Boolean(def && def.duration && stateTime >= def.duration);
        },
        // Request a transition. Returns false (and changes nothing) when the
        // current state does not allow it. Re-entering the same state resets
        // its timer, which is how repeated hits re-trigger the flinch.
        set: function (name) {
            if (name === state) {
                stateTime = 0;
                return true;
            }
            const def = table[state];
            if (!def || def.exits.indexOf(name) === -1) {
                return false;
            }
            state = name;
            stateTime = 0;
            return true;
        },
        // Terminal-state escape hatch for 踏みとどまり (spec/04 §4.2 type 11):
        // `dead` has no exits by design, but the survival passive revives the
        // player in the same tick the fatal hit tried to enter it. This is
        // the only sanctioned way out of a terminal state.
        force: function (name) {
            state = name;
            stateTime = 0;
            return true;
        },
        update: function (dt) {
            stateTime += dt;
            const def = table[state];
            if (def && def.duration && def.next && stateTime >= def.duration) {
                state = def.next;
                stateTime = 0;
            }
        },
        is: function (name) { return state === name; }
    };
    return machine;
}
