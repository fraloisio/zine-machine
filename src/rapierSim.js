import RAPIER from "@dimforge/rapier2d-compat";

// One-time init promise — safe to import multiple times
let _ready = null;
export const rapierReady = () => (_ready ??= RAPIER.init().then(() => RAPIER));

const DEG = Math.PI / 180;

// Build a Rapier world from the design's parts + joints.
// Returns { world, bodyMap: Map<partId, RigidBody>, step, readParts }
export async function buildRapierSim(parts, joints, constraintMap, getLocalHoles, worldHoles) {
  await rapierReady();

  const world = new RAPIER.World({ x: 0, y: 0 }); // no gravity
  world.timestep = 1 / 60;

  // partId → RigidBody
  const bodyMap = new Map();

  // --- Create one rigid body per part ---
  for (const part of parts) {
    let desc;
    if (part.type === "motor") {
      desc = RAPIER.RigidBodyDesc.kinematicVelocityBased();
    } else {
      desc = RAPIER.RigidBodyDesc.dynamic();
    }
    desc.setTranslation(part.x, part.y);
    desc.setRotation(part.rotation * DEG);
    // Lock linear DOF so only rotation matters (linkage, not free particle)
    // Actually we want full planar DOF for dynamic bodies — leave it.
    const body = world.createRigidBody(desc);

    // Tiny sensor collider so Rapier tracks inertia; no part-to-part collision needed
    const holes = getLocalHoles(part);
    const span = holes.length > 1
      ? Math.hypot(holes[holes.length - 1].x - holes[0].x, holes[holes.length - 1].y - holes[0].y) / 2
      : 0.5;
    const col = RAPIER.ColliderDesc.ball(Math.max(span, 0.1))
      .setSensor(true)
      .setDensity(part.type === "motor" ? 0 : 1);
    world.createCollider(col, body);

    bodyMap.set(part.id, body);
  }

  // --- Motor angular velocity ---
  const MOTOR_SPEED_DEG = 90; // default deg/s — matches App.jsx
  for (const part of parts) {
    if (part.type !== "motor") continue;
    const body = bodyMap.get(part.id);
    const speed = (part.speed ?? MOTOR_SPEED_DEG) * (part.direction ?? 1) * DEG; // rad/s
    body.setAngvel(speed, true);
  }

  // --- Joints ---
  // Ground anchors: static body per ground joint world position
  for (const joint of joints) {
    const cm = constraintMap.get(joint.id);
    if (!cm || cm.length === 0) continue;

    if (joint.kind === "ground") {
      const entry = cm[0];
      const body = bodyMap.get(entry.partId);
      if (!body) continue;
      const part = parts.find(p => p.id === entry.partId);
      const localHoles = getLocalHoles(part);
      const lh = localHoles[entry.holeIdx];
      if (!lh) continue;

      // Static anchor at the ground world position
      const anchorDesc = RAPIER.RigidBodyDesc.fixed().setTranslation(joint.x, joint.y);
      const anchor = world.createRigidBody(anchorDesc);

      // Revolute: anchor body at (0,0) local, part body at lh local
      const jd = RAPIER.JointData.revolute({ x: 0, y: 0 }, { x: lh.x, y: lh.y });
      world.createImpulseJoint(jd, anchor, body, true);

    } else if (joint.kind === "pivot" && cm.length >= 2) {
      const [entA, entB] = cm;
      const bodyA = bodyMap.get(entA.partId);
      const bodyB = bodyMap.get(entB.partId);
      if (!bodyA || !bodyB) continue;
      const partA = parts.find(p => p.id === entA.partId);
      const partB = parts.find(p => p.id === entB.partId);
      const lhA = getLocalHoles(partA)[entA.holeIdx];
      const lhB = getLocalHoles(partB)[entB.holeIdx];
      if (!lhA || !lhB) continue;

      const jd = RAPIER.JointData.revolute({ x: lhA.x, y: lhA.y }, { x: lhB.x, y: lhB.y });
      world.createImpulseJoint(jd, bodyA, bodyB, true);

    } else if (joint.kind === "weld" && cm.length >= 2) {
      const [entA, entB] = cm;
      const bodyA = bodyMap.get(entA.partId);
      const bodyB = bodyMap.get(entB.partId);
      if (!bodyA || !bodyB) continue;
      const partA = parts.find(p => p.id === entA.partId);
      const partB = parts.find(p => p.id === entB.partId);

      // Fixed joint: pin bodyA's origin to the corresponding point on bodyB.
      // anchor1=(0,0) in A-local. anchor2 = A's origin expressed in B-local.
      const posA = bodyA.translation(), rotA = bodyA.rotation();
      const posB = bodyB.translation(), rotB = bodyB.rotation();
      // Vector from B to A in world space, rotated into B-local frame
      const axW = posA.x - posB.x, ayW = posA.y - posB.y;
      const cosNB = Math.cos(-rotB), sinNB = Math.sin(-rotB);
      const a2x = axW * cosNB - ayW * sinNB;
      const a2y = axW * sinNB + ayW * cosNB;
      // frame constraint: bodyA.rot + 0 = bodyB.rot + frame2 → frame2 = -(rotB-rotA)
      const frame2 = -(rotB - rotA);

      const jd = RAPIER.JointData.fixed({ x: 0, y: 0 }, 0, { x: a2x, y: a2y }, frame2);
      world.createImpulseJoint(jd, bodyA, bodyB, true);
    }
  }

  // --- Step and read-back ---
  // Timestep is fixed at 1/60 at world creation — one step = one real frame.
  function step(_dt) {
    world.step();
  }

  function readParts(prevParts) {
    return prevParts.map(part => {
      const body = bodyMap.get(part.id);
      if (!body) return part;
      const t = body.translation();
      const r = body.rotation(); // radians
      return { ...part, x: t.x, y: t.y, rotation: r / DEG };
    });
  }

  return { world, bodyMap, step, readParts };
}
