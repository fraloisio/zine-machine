import RAPIER from "@dimforge/rapier2d-compat";

await RAPIER.init();

const world = new RAPIER.World({ x: 0, y: 0 }); // no gravity

const BAR_LENGTH = 5.0;
const ANGULAR_VEL = 1.0; // rad/s
const DT = 1 / 60;

// Motor: kinematic body at origin
const motorDesc = RAPIER.RigidBodyDesc.kinematicVelocityBased().setTranslation(0, 0);
const motor = world.createRigidBody(motorDesc);
motor.setAngvel(ANGULAR_VEL, true);

// Give motor a tiny collider so Rapier tracks it
world.createCollider(RAPIER.ColliderDesc.ball(0.01), motor);

// Bar: dynamic body, initially pointing along +x from (0,0)
// Anchor in bar-local space is at its near end (-BAR_LENGTH/2, 0)
// so the bar's center starts at (BAR_LENGTH/2, 0)
const barDesc = RAPIER.RigidBodyDesc.dynamic().setTranslation(BAR_LENGTH / 2, 0);
const bar = world.createRigidBody(barDesc);
world.createCollider(
  RAPIER.ColliderDesc.cuboid(BAR_LENGTH / 2, 0.05).setDensity(1),
  bar
);

// Revolute joint pinning bar's near end to motor's origin
const jointParams = RAPIER.JointData.revolute(
  { x: 0, y: 0 },          // anchor on motor (world origin)
  { x: -BAR_LENGTH / 2, y: 0 } // anchor on bar (near end in bar-local)
);
world.createImpulseJoint(jointParams, motor, bar, true);

const initialRadius = BAR_LENGTH;
let maxDrift = 0;

for (let frame = 0; frame < 60; frame++) {
  world.step();

  const barPos = bar.translation();
  const barAngle = bar.rotation();

  // Far end of bar in world space
  const farX = barPos.x + Math.cos(barAngle) * (BAR_LENGTH / 2);
  const farY = barPos.y + Math.sin(barAngle) * (BAR_LENGTH / 2);

  const radius = Math.hypot(farX, farY);
  const drift = Math.abs(radius - initialRadius);
  if (drift > maxDrift) maxDrift = drift;

  console.log(`frame ${String(frame + 1).padStart(2)}: far=(${farX.toFixed(4)}, ${farY.toFixed(4)})  r=${radius.toFixed(6)}  drift=${drift.toFixed(6)}`);
}

console.log(`\nMax drift over 60 frames: ${maxDrift.toFixed(6)}`);
if (maxDrift > 1) {
  console.error("FAIL: radius drifted more than 1px");
  process.exit(1);
} else {
  console.log("PASS");
}
