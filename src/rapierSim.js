import RAPIER from "@dimforge/rapier2d-compat";

let _ready = null;
export const rapierReady = () => (_ready ??= RAPIER.init().then(() => RAPIER));

const DEG = Math.PI / 180;

/**
 * GEMINI RAPIER REFACTOR v6
 * Stability: Warm-start settling + Velocity Clamping
 */

export async function buildRapierSim(parts, joints, constraintMap, getLocalHoles, _worldHoles) {
  await rapierReady();

  const world = new RAPIER.World({ x: 0, y: 0 });
  const SUBSTEPS = 8;
  world.timestep = (1 / 60) / SUBSTEPS;
  world.numSolverIterations = 60;

  // --- 1. CLUSTERING ---
  const parent = new Map(parts.map(p => [p.id, p.id]));
  function find(id) {
    if (parent.get(id) !== id) parent.set(id, find(parent.get(id)));
    return parent.get(id);
  }
  function union(a, b) {
    const ra = find(a), rb = find(b);
    if (ra !== rb) parent.set(rb, ra);
  }
  for (const joint of joints) {
    if (joint.kind === "weld") {
      const ids = joint.partIds;
      if (ids.length >= 2) {
        for (let i = 1; i < ids.length; i++) union(ids[0], ids[i]);
      }
    }
  }

  const clusterGroups = new Map();
  for (const part of parts) {
    const rootId = find(part.id);
    if (!clusterGroups.has(rootId)) clusterGroups.set(rootId, []);
    clusterGroups.get(rootId).push(part);
  }

  // --- 2. BODY CREATION ---
  const bodyMap = new Map(); 
  const memberOffsets = new Map(); 

  for (const [rootId, group] of clusterGroups) {
    const rootPart = parts.find(p => p.id === rootId);
    if (!rootPart) continue;

    const desc = RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(rootPart.x, rootPart.y)
      .setRotation(rootPart.rotation * DEG)
      .setLinearDamping(0)
      .setAngularDamping(0)
      .setCanSleep(false);
    
    const body = world.createRigidBody(desc);

    for (const part of group) {
      bodyMap.set(part.id, body);
      const dx = part.x - rootPart.x;
      const dy = part.y - rootPart.y;
      const cosR = Math.cos(-rootPart.rotation * DEG), sinR = Math.sin(-rootPart.rotation * DEG);
      const lx = dx * cosR - dy * sinR;
      const ly = dx * sinR + dy * cosR;
      const dRot = (part.rotation - rootPart.rotation) * DEG;
      memberOffsets.set(part.id, { lx, ly, dRot });

      const holes = getLocalHoles(part);
      let col;
      if (part.type === "strip" || part.type === "slottedStrip") {
        const n = part.size || 3;
        const halfLen = (n - 1) / 2;
        col = RAPIER.ColliderDesc.cuboid(halfLen + 0.35, 0.2)
          .setTranslation(lx + halfLen * Math.cos(dRot), ly + halfLen * Math.sin(dRot))
          .setRotation(dRot);
      } else {
        const maxR = holes.reduce((m, h) => Math.max(m, Math.hypot(h.x, h.y)), 0.5);
        col = RAPIER.ColliderDesc.ball(maxR + 0.3).setTranslation(lx, ly);
      }
      col.setSensor(true).setDensity(1.0);
      world.createCollider(col, body);
    }
  }

  function getHoleInRootLocal(partId, holeIdx) {
    const offset = memberOffsets.get(partId);
    const part = parts.find(p => p.id === partId);
    if (!part || !offset) return { x: 0, y: 0 };
    const holes = getLocalHoles(part);
    const lh = holes[holeIdx] || holes[0] || { x: 0, y: 0 };
    const cosR = Math.cos(offset.dRot), sinR = Math.sin(offset.dRot);
    return {
      x: offset.lx + (lh.x * cosR - lh.y * sinR),
      y: offset.ly + (lh.x * sinR + lh.y * cosR)
    };
  }

  // --- 3. MOTORS ---
  const motorJoints = new Map();
  for (const part of parts) {
    if (part.type !== "motor") continue;
    const body = bodyMap.get(part.id);
    if (!body) continue;
    
    const localPos = getHoleInRootLocal(part.id, 0);
    const anchor = world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(part.x, part.y));
    const jd = RAPIER.JointData.revolute({ x: 0, y: 0 }, localPos);
    jd.motorEnabled = true;
    jd.motorMaxForce = part.torque ?? 1000000;
    
    const liveJoint = world.createImpulseJoint(jd, anchor, body, true);
    const speed = (part.speed ?? 90) * (part.direction ?? 1) * DEG;
    // Initially zero speed for warm-start
    liveJoint.configureMotorVelocity(0, 0.5);
    motorJoints.set(part.id, { joint: liveJoint, targetSpeed: speed });
  }

  // --- 4. JOINTS ---
  const userJoints = new Map();
  for (const joint of joints) {
    const cm = constraintMap.get(joint.id);
    if (!cm || cm.length === 0 || joint.kind === "weld") continue;
    const instances = [];

    if (joint.kind === "ground") {
      const anchorBody = world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(joint.x, joint.y));
      for (const entry of cm) {
        const body = bodyMap.get(entry.partId);
        if (!body || parts.find(p => p.id === entry.partId)?.type === "motor") continue;
        const localPos = getHoleInRootLocal(entry.partId, entry.holeIdx);
        instances.push(world.createImpulseJoint(RAPIER.JointData.revolute({ x: 0, y: 0 }, localPos), anchorBody, body, true));
      }
    } else if (joint.kind === "pivot") {
      const slotEntry = cm.find(e => e.isSlot);
      if (slotEntry) {
        const railPart = parts.find(p => p.id === slotEntry.partId);
        const railBody = bodyMap.get(slotEntry.partId);
        if (railBody) {
          const sliderBody = world.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(joint.x, joint.y).setRotation(railBody.rotation()).setCanSleep(false));
          world.createCollider(RAPIER.ColliderDesc.ball(0.1).setSensor(true).setDensity(1.0), sliderBody);
          const railOffset = memberOffsets.get(slotEntry.partId);
          const axis = { x: Math.cos(railOffset?.dRot||0), y: Math.sin(railOffset?.dRot||0) };
          const pjd = RAPIER.JointData.prismatic(getHoleInRootLocal(slotEntry.partId, 0), { x: 0, y: 0 }, axis);
          pjd.limitsEnabled = true;
          pjd.limits = [0, railPart.size - 1];
          instances.push(world.createImpulseJoint(pjd, railBody, sliderBody, true));
          for (const entry of cm) {
            if (entry === slotEntry) continue;
            const bodyB = bodyMap.get(entry.partId);
            if (bodyB) instances.push(world.createImpulseJoint(RAPIER.JointData.revolute({ x: 0, y: 0 }, getHoleInRootLocal(entry.partId, entry.holeIdx)), sliderBody, bodyB, true));
          }
        }
      } else {
        const entA = cm[0];
        const bodyA = bodyMap.get(entA.partId);
        const localA = getHoleInRootLocal(entA.partId, entA.holeIdx);
        for (let i = 1; i < cm.length; i++) {
          const bodyB = bodyMap.get(cm[i].partId);
          if (bodyB && bodyA !== bodyB) instances.push(world.createImpulseJoint(RAPIER.JointData.revolute(localA, getHoleInRootLocal(cm[i].partId, cm[i].holeIdx)), bodyA, bodyB, true));
        }
      }
    }
    userJoints.set(joint.id, instances);
  }

  function step(dt, frameCount) { 
    // Warm-start: Disable motors for first 20 frames to let constraints settle
    for (const [_, m] of motorJoints) {
      m.joint.configureMotorVelocity(frameCount > 20 ? m.targetSpeed : 0, 0.5);
    }

    world.timestep = dt / SUBSTEPS;
    for (let i = 0; i < SUBSTEPS; i++) {
      world.step();
      // Velocity clamping to prevent explosions
      world.forEachActiveRigidBody(body => {
        const v = body.linvel();
        const mag = Math.hypot(v.x, v.y);
        if (mag > 50) {
          body.setLinvel({ x: (v.x/mag)*50, y: (v.y/mag)*50 }, true);
        }
        const av = body.angvel();
        if (Math.abs(av) > 20) {
          body.setAngvel(av > 0 ? 20 : -20, true);
        }
      });
    }
  }

  function readParts(prevParts) {
    return prevParts.map(part => {
      const body = bodyMap.get(part.id);
      if (!body) return part;
      const offset = memberOffsets.get(part.id);
      const bPos = body.translation(), bRot = body.rotation();
      const cosR = Math.cos(bRot), sinR = Math.sin(bRot);
      return {
        ...part,
        x: bPos.x + (offset.lx * cosR - offset.ly * sinR),
        y: bPos.y + (offset.lx * sinR + offset.ly * cosR),
        rotation: (bRot + (offset.dRot || 0)) / DEG
      };
    });
  }

  function getDiagnostics() {
    const diag = { timestamp: Date.now(), bodies: [], joints: [] };
    for (const [partId, body] of bodyMap) {
      const t = body.translation(), r = body.rotation();
      diag.bodies.push({ id: partId, pos: [t.x.toFixed(3), t.y.toFixed(3)], rot: (r / DEG).toFixed(1) });
    }
    for (const [jid, instances] of userJoints) {
      instances.forEach((inst, idx) => {
        try {
          const impulse = inst.reactionImpulse;
          diag.joints.push({ id: jid, subIdx: idx, impulse: { x: impulse.x.toFixed(4), y: impulse.y.toFixed(4) } });
        } catch (e) {}
      });
    }
    return diag;
  }

  return { world, bodyMap, step, readParts, getDiagnostics };
}
