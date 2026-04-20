import { useReducer, useState, useRef, useEffect, useCallback, useMemo } from "react";
import {
  MousePointer2, Move, Trash2, Undo2, Redo2, Hammer, Play, Pause,
  Anchor, Link2, Circle as CircleIcon, Info, Music, Waves, Sparkles,
  Bell, ChevronRight, AlignJustify, AlertTriangle, Hand
} from "lucide-react";

/* ============================================================
   ZINE MACHINE — Round 1
   Construction mode only. Animation comes in Round 2.
   ============================================================ */

// ---------- Constants ----------
const GRID = 28;                   // px per grid cell
const SECTION_COLS = 30;
const SECTION_ROWS = 20;
const COLS = SECTION_COLS * 3;
const ROWS = SECTION_ROWS * 3;
const STRIP_W = 0.72;              // strip width in grid units
const HOLE_R_PART = 2.8;           // hole radius on parts
const HOLE_R_BOARD = 1.8;  // pegboard dot radius
const JOINT_R = 8;                 // joint pin radius
const ANGLE_SNAP = 15;             // degrees
const BOARD_PAD = 0.7;             // grid units of padding around the board
const MAX_HISTORY = 80;
const SELECT_STROKE = 2.5;         // dashed halo stroke width
const MOTOR_SPEED_DEG = 90;        // degrees per second

// Bell instrument notes
const NOTES = {
  'C4': 261.63, 'D4': 293.66, 'E4': 329.63, 'F4': 349.23,
  'G4': 392.00, 'A4': 440.00, 'B4': 493.88, 'C5': 523.25,
};

let _audioCtx = null;
function getAudioCtx() {
  if (!_audioCtx) _audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  return _audioCtx;
}
function playNote(freq) {
  try {
    const ctx = getAudioCtx();
    if (ctx.state === 'suspended') ctx.resume();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain); gain.connect(ctx.destination);
    osc.frequency.value = freq; osc.type = 'sine';
    gain.gain.setValueAtTime(0.45, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 1.4);
    osc.start(ctx.currentTime); osc.stop(ctx.currentTime + 1.4);
  } catch (_) {}
}

const COLORS = {
  shell:       "#1a0f14",
  shellDeep:   "#0e0709",
  board:       "#e53e7a",
  boardDeep:   "#b2205d",
  boardDot:    "#2a0a18",
  part:        "#f4ecd6",
  partEdge:    "#1a0f14",
  partHole:    "#1a0f14",
  slot:        "#1a0f14",
  select:      "#ffd23f",
  motor:       "#f5c518",
  ghost:       "rgba(244,236,214,0.45)",
  ink:         "#f4ecd6",
  inkDim:      "#b89a84",
  pivot:       "#3ddc6a",
  weld:        "#ff4d4d",
  ground:      "#4aa3ff",
  sidebar:     "#120a0e",
  divider:     "#2a1a20",
};

const PALETTE = [
  { id: "strip",    type: "strip" },
  { id: "slot",     type: "slottedStrip" },
  { id: "triangle", type: "triangle" },
  { id: "square",   type: "square" },
  { id: "pentagon", type: "pentagon" },
  { id: "motor",    type: "motor" },
  { id: "bell",          type: "bell" },
  { id: "finger-right", type: "stamp", glyph: "☞" },
  { id: "finger-left",  type: "stamp", glyph: "☜" },
];

// ---------- Geometry ----------
function getLocalHoles(part) {
  switch (part.type) {
    case "strip":
    case "slottedStrip":
      return Array.from({ length: part.size }, (_, i) => ({ x: i, y: 0 }));
    case "triangle": {
      const s = 3;
      return [
        { x: 0, y: 0 },
        { x: s, y: 0 },
        { x: s / 2, y: -s * Math.sqrt(3) / 2 },
        { x: s / 2, y: -s * Math.sqrt(3) / 6 }, // centroid
      ];
    }
    case "square":
      return [
        { x: 0, y: 0 },
        { x: 2, y: 0 },
        { x: 2, y: 2 },
        { x: 0, y: 2 },
        { x: 1, y: 1 }, // centroid
      ];
    case "pentagon": {
      const r = 1.7;
      const verts = Array.from({ length: 5 }, (_, i) => {
        const a = -Math.PI / 2 + i * (2 * Math.PI / 5);
        return { x: r * Math.cos(a) + r, y: r * Math.sin(a) + r };
      });
      return [...verts, { x: r, y: r }]; // centroid
    }
    case "motor":
      // Center axle + 4 cardinal holes at radius 2 — these land exactly on grid dots
      return [
        { x: 0, y: 0 },
        { x: 2, y: 0 }, { x: 0, y: 2 }, { x: -2, y: 0 }, { x: 0, y: -2 },
      ];
    case "bell":
    case "stamp":
      return [{ x: 0, y: 0 }];
    default: return [];
  }
}

function rotate({ x, y }, deg) {
  const r = deg * Math.PI / 180;
  return { x: x * Math.cos(r) - y * Math.sin(r), y: x * Math.sin(r) + y * Math.cos(r) };
}

function worldHoles(part) {
  return getLocalHoles(part).map(h => {
    const r = rotate(h, part.rotation);
    return { x: part.x + r.x, y: part.y + r.y };
  });
}

// Polygon outline vertices — extended 0.5 grid units beyond each vertex outward from centroid.
// Computed from shape vertex positions only (independent of holes so centroid hole doesn't shift outline).
function getLocalVertices(part) {
  let verts;
  switch (part.type) {
    case "triangle": {
      const s = 3;
      verts = [{x:0,y:0}, {x:s,y:0}, {x:s/2, y:-s*Math.sqrt(3)/2}];
      break;
    }
    case "square":
      verts = [{x:0,y:0}, {x:2,y:0}, {x:2,y:2}, {x:0,y:2}];
      break;
    case "pentagon": {
      const r = 1.7;
      verts = Array.from({length:5}, (_, i) => {
        const a = -Math.PI/2 + i*(2*Math.PI/5);
        return {x: r*Math.cos(a)+r, y: r*Math.sin(a)+r};
      });
      break;
    }
    default: return [];
  }
  const cx = verts.reduce((s, h) => s + h.x, 0) / verts.length;
  const cy = verts.reduce((s, h) => s + h.y, 0) / verts.length;
  return verts.map(h => {
    const dx = h.x - cx, dy = h.y - cy;
    const dist = Math.hypot(dx, dy);
    if (dist < 0.001) return h;
    return { x: h.x + (dx / dist) * 0.5, y: h.y + (dy / dist) * 0.5 };
  });
}

function partLabel(p) {
  if (p.type === "strip") return `Strip ${p.size}`;
  if (p.type === "slottedStrip") return `Slot ${p.size}`;
  if (p.type === "motor") return "Motor";
  return p.type[0].toUpperCase() + p.type.slice(1);
}

function getPivotHoleOptions(part) {
  if (part.type !== "strip" && part.type !== "slottedStrip") return [];
  return [0, part.size - 1];
}

function roundedPolygonPath(verts, r) {
  const n = verts.length;
  let d = '';
  for (let i = 0; i < n; i++) {
    const prev = verts[(i - 1 + n) % n];
    const curr = verts[i];
    const next = verts[(i + 1) % n];
    const d1x = curr.x - prev.x, d1y = curr.y - prev.y;
    const d2x = next.x - curr.x, d2y = next.y - curr.y;
    const l1 = Math.hypot(d1x, d1y), l2 = Math.hypot(d2x, d2y);
    const cr = Math.min(r, l1 / 2, l2 / 2);
    const p1x = curr.x - (d1x / l1) * cr, p1y = curr.y - (d1y / l1) * cr;
    const p2x = curr.x + (d2x / l2) * cr, p2y = curr.y + (d2y / l2) * cr;
    if (i === 0) d += `M ${p1x} ${p1y}`;
    else d += ` L ${p1x} ${p1y}`;
    d += ` Q ${curr.x} ${curr.y} ${p2x} ${p2y}`;
  }
  return d + ' Z';
}

// ---------- Reducer ----------
const initial = {
  parts: [],
  joints: [],
  selectedId: null,
  tool: "select",
  palette: null,
  mode: "build",
  undo: [],
  redo: [],
  nextId: 1,
};

function snap(state) {
  return {
    undo: [...state.undo.slice(-(MAX_HISTORY - 1)), { parts: state.parts, joints: state.joints }],
    redo: [],
  };
}

function reducer(state, action) {
  switch (action.type) {
    case "TOOL":
      return { ...state, tool: action.tool, palette: null, selectedId: null };
    case "PALETTE":
      return { ...state, palette: action.id, tool: "place", selectedId: null };
    case "MODE":
      return { ...state, mode: action.mode, selectedId: null, tool: "select" };
    case "SELECT":
      return { ...state, selectedId: action.id };
    case "ADD_PART": {
      const id = "p" + state.nextId;
      const part = { id, ...action.part };
      return {
        ...state,
        ...snap(state),
        parts: [...state.parts, part],
        nextId: state.nextId + 1,
        selectedId: id,
        tool: "select",
        palette: null,
      };
    }
    case "UPDATE_PART": {
      return {
        ...state,
        ...snap(state),
        parts: state.parts.map(p => p.id === action.id ? { ...p, ...action.updates } : p),
      };
    }
    case "UPDATE_PART_LIVE": {
      return {
        ...state,
        parts: state.parts.map(p => p.id === action.id ? { ...p, ...action.updates } : p),
      };
    }
    case "BATCH_UPDATE_PARTS_LIVE": {
      return {
        ...state,
        parts: state.parts.map(p => {
          const upd = action.updates[p.id];
          return upd ? { ...p, ...upd } : p;
        }),
      };
    }
    case "SNAPSHOT": {
      return { ...state, ...snap(state) };
    }
    case "DELETE_PART": {
      return {
        ...state,
        ...snap(state),
        parts: state.parts.filter(p => p.id !== action.id),
        joints: state.joints.filter(j => !j.partIds.includes(action.id)),
        selectedId: state.selectedId === action.id ? null : state.selectedId,
      };
    }
    case "DUPLICATE_PART": {
      const src = state.parts.find(p => p.id === action.id);
      if (!src) return state;
      const newPart = { ...src, id: "p" + state.nextId, x: src.x + 1, y: src.y + 1 };
      return {
        ...state,
        ...snap(state),
        parts: [...state.parts, newPart],
        nextId: state.nextId + 1,
        selectedId: newPart.id,
      };
    }
    case "ADD_JOINT": {
      const id = "j" + state.nextId;
      return {
        ...state,
        ...snap(state),
        joints: [...state.joints, { id, ...action.joint }],
        nextId: state.nextId + 1,
      };
    }
    case "DELETE_JOINT": {
      return {
        ...state,
        ...snap(state),
        joints: state.joints.filter(j => j.id !== action.id),
      };
    }
    case "UNDO": {
      if (state.undo.length === 0) return state;
      const prev = state.undo[state.undo.length - 1];
      return {
        ...state,
        parts: prev.parts,
        joints: prev.joints,
        undo: state.undo.slice(0, -1),
        redo: [...state.redo, { parts: state.parts, joints: state.joints }],
        selectedId: null,
      };
    }
    case "REDO": {
      if (state.redo.length === 0) return state;
      const next = state.redo[state.redo.length - 1];
      return {
        ...state,
        parts: next.parts,
        joints: next.joints,
        redo: state.redo.slice(0, -1),
        undo: [...state.undo, { parts: state.parts, joints: state.joints }],
        selectedId: null,
      };
    }
    case "CLEAR":
      return { ...state, ...snap(state), parts: [], joints: [], selectedId: null };
    case "BRING_FORWARD": {
      return {
        ...state,
        ...snap(state),
        parts: state.parts.map(p => p.id === action.id ? { ...p, zIndex: (p.zIndex ?? 0) + 1 } : p),
      };
    }
    case "SEND_BACKWARD": {
      return {
        ...state,
        ...snap(state),
        parts: state.parts.map(p => p.id === action.id ? { ...p, zIndex: Math.max(0, (p.zIndex ?? 0) - 1) } : p),
      };
    }
    case "CONVERT_JOINT": {
      return {
        ...state,
        ...snap(state),
        joints: state.joints.map(j => j.id === action.id ? { ...j, kind: action.kind } : j),
      };
    }
    case "MOVE_JOINT_LIVE": {
      return {
        ...state,
        joints: state.joints.map(j => j.id === action.id ? { ...j, x: action.x, y: action.y } : j),
      };
    }
    case "COMMIT_JOINT_MOVE": {
      return {
        ...state,
        joints: state.joints.map(j => j.id === action.id
          ? { ...j, x: action.x, y: action.y, partIds: action.partIds }
          : j),
      };
    }
    case "LOAD_STATE": {
      return {
        ...state,
        parts: action.data.parts ?? [],
        joints: action.data.joints ?? [],
        nextId: action.data.nextId ?? 1,
        selectedId: null,
        tool: "select",
        palette: null,
        undo: [],
        redo: [],
      };
    }
    case "DELETE_PARTS": {
      const ids = new Set(action.ids);
      return {
        ...state,
        ...snap(state),
        parts: state.parts.filter(p => !ids.has(p.id)),
        joints: state.joints.filter(j => !j.partIds.some(id => ids.has(id))),
        selectedId: ids.has(state.selectedId) ? null : state.selectedId,
      };
    }
    default:
      return state;
  }
}

// ---------- Part shapes (pure SVG) ----------
function StripShape({ part, ghost = false }) {
  const n = part.size;
  const len = (n - 1) * GRID;
  const w = STRIP_W * GRID;
  const pad = w / 2;
  const holes = getLocalHoles(part);
  return (
    <g opacity={ghost ? 0.45 : 1}>
      <rect
        x={-pad} y={-w / 2}
        width={len + 2 * pad} height={w}
        rx={w / 2} ry={w / 2}
        fill={COLORS.part}
        stroke={COLORS.partEdge}
        strokeWidth="1.4"
      />
      {holes.map((h, i) => (
        <circle key={i} cx={h.x * GRID} cy={h.y * GRID} r={HOLE_R_PART} fill={COLORS.partHole} />
      ))}
    </g>
  );
}

function SlottedStripShape({ part, ghost = false }) {
  const n = part.size;
  const len = (n - 1) * GRID;
  const w = STRIP_W * GRID;
  const pad = w / 2;
  const slotPad = 0.45 * GRID;
  const slotW = 0.22 * GRID;
  const holes = getLocalHoles(part);
  return (
    <g opacity={ghost ? 0.45 : 1}>
      <rect
        x={-pad} y={-w / 2}
        width={len + 2 * pad} height={w}
        rx={w / 2} ry={w / 2}
        fill={COLORS.part}
        stroke={COLORS.partEdge}
        strokeWidth="1.4"
      />
      {/* slot */}
      <rect
        x={slotPad} y={-slotW / 2}
        width={len - 2 * slotPad} height={slotW}
        rx={slotW / 2} ry={slotW / 2}
        fill={COLORS.slot}
      />
      {holes.map((h, i) => (
        <circle key={i} cx={h.x * GRID} cy={h.y * GRID} r={HOLE_R_PART} fill={COLORS.partHole} />
      ))}
    </g>
  );
}

function PolyShape({ part, ghost = false }) {
  const holes = getLocalHoles(part);
  const vertices = getLocalVertices(part);
  const d = roundedPolygonPath(vertices.map(v => ({ x: v.x * GRID, y: v.y * GRID })), 8);
  return (
    <g opacity={ghost ? 0.45 : 1}>
      <path d={d} fill={COLORS.part} stroke={COLORS.partEdge} strokeWidth="1.4" />
      {holes.map((h, i) => (
        <circle key={i} cx={h.x * GRID} cy={h.y * GRID} r={HOLE_R_PART} fill={COLORS.partHole} />
      ))}
    </g>
  );
}

function MotorShape({ part, ghost = false }) {
  const holes = getLocalHoles(part);
  const outerHoles = holes.slice(1); // skip center
  const R = 2.5 * GRID;
  const hubR = 0.55 * GRID;
  const dir = part.direction ?? 1; // 1=CW, -1=CCW
  // Arrow arc fits in the NE quadrant (CW) or NW quadrant (CCW) — between the spoke lines
  const arrowR = 2.1 * GRID;
  const sa = (dir === 1 ? -75 : -105) * Math.PI / 180;
  const ea = (dir === 1 ? -30 : -150) * Math.PI / 180;
  const sweep = dir === 1 ? 1 : 0;
  const sx = arrowR * Math.cos(sa), sy = arrowR * Math.sin(sa);
  const ex = arrowR * Math.cos(ea), ey = arrowR * Math.sin(ea);
  // Tangent direction at arc endpoint (CW: rotate radius 90° in CW dir)
  const tx = -dir * Math.sin(ea), ty = dir * Math.cos(ea);
  const backAngle = Math.atan2(-ty, -tx);
  const ah = 5;
  return (
    <g opacity={ghost ? 0.45 : 1}>
      <circle cx={0} cy={0} r={R} fill={COLORS.motor} stroke={COLORS.partEdge} strokeWidth="1.6" />
      {outerHoles.map((h, i) => (
        <line key={`sp${i}`} x1={0} y1={0} x2={h.x * GRID} y2={h.y * GRID}
          stroke={COLORS.partEdge} strokeWidth="1.2" opacity="0.4" />
      ))}
      <circle cx={0} cy={0} r={hubR} fill={COLORS.partEdge} />
      <circle cx={0} cy={0} r={hubR * 0.4} fill={COLORS.motor} />
      {/* Direction arrow */}
      <path
        d={`M ${sx} ${sy} A ${arrowR} ${arrowR} 0 0 ${sweep} ${ex} ${ey}`}
        fill="none" stroke={COLORS.partEdge} strokeWidth="2.2" strokeLinecap="round" opacity="0.75"
      />
      <path
        d={`M ${ex + ah * Math.cos(backAngle + 0.45)} ${ey + ah * Math.sin(backAngle + 0.45)} L ${ex} ${ey} L ${ex + ah * Math.cos(backAngle - 0.45)} ${ey + ah * Math.sin(backAngle - 0.45)}`}
        fill="none" stroke={COLORS.partEdge} strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" opacity="0.75"
      />
      {holes.map((h, i) => (
        <circle key={i} cx={h.x * GRID} cy={h.y * GRID} r={HOLE_R_PART} fill={COLORS.partHole} />
      ))}
    </g>
  );
}

function BellShape({ part, ghost = false }) {
  const s = GRID * 0.85;
  return (
    <g opacity={ghost ? 0.45 : 1}>
      <path
        d={`M 0 ${-s * 1.1} Q ${s * 0.5} ${-s * 1.0} ${s * 0.9} ${s * 0.25} L ${-s * 0.9} ${s * 0.25} Q ${-s * 0.5} ${-s * 1.0} 0 ${-s * 1.1}`}
        fill={COLORS.motor} stroke={COLORS.partEdge} strokeWidth="1.4"
      />
      <line x1={-s * 0.9} y1={s * 0.25} x2={s * 0.9} y2={s * 0.25} stroke={COLORS.partEdge} strokeWidth="1.4" />
      <line x1={0} y1={s * 0.25} x2={0} y2={s * 0.55} stroke={COLORS.partEdge} strokeWidth="1.4" />
      <circle cx={0} cy={s * 0.6} r={3.5} fill={COLORS.partEdge} />
      <circle cx={0} cy={0} r={HOLE_R_PART} fill={COLORS.partHole} />
    </g>
  );
}

function StampShape({ part, ghost = false }) {
  const s = GRID * 2.4;
  const glyph = part.glyph ?? "☞";
  const isMirror = glyph === "☜";
  // Shift the glyph so the cuff (wrist end) lands on the pivot hole at (0,0).
  // ☞ points right → cuff is on the left → shift text rightward.
  // ☜ points left  → cuff is on the right → shift text leftward.
  const textX = isMirror ? -s * 0.48 : s * 0.48;
  const textY = s * 0.48;
  const fid = `stamp-bg-${part.id ?? 'ghost'}`;
  return (
    <g opacity={ghost ? 0.45 : 1}>
      <defs>
        <filter id={fid} x="-50%" y="-50%" width="200%" height="200%" colorInterpolationFilters="sRGB">
          <feMorphology operator="dilate" radius="18" result="d"/>
          <feMorphology in="d" operator="erode" radius="18" result="closed"/>
          <feFlood floodColor="white" result="white"/>
          <feComposite in="white" in2="closed" operator="in"/>
        </filter>
      </defs>
      <text
        x={textX} y={textY}
        textAnchor="middle"
        fontSize={s * 1.4}
        fontFamily="'Noto Symbols 2', sans-serif"
        filter={`url(#${fid})`}
        fill={COLORS.partEdge}
        pointerEvents="none"
      >{glyph}</text>
      <text
        x={textX} y={textY}
        textAnchor="middle"
        fontSize={s * 1.4}
        fontFamily="'Noto Symbols 2', sans-serif"
        fill={COLORS.partEdge}
      >{glyph}</text>
      {/* Pivot hole at cuff */}
      <circle cx={0} cy={0} r={HOLE_R_PART} fill={COLORS.partHole} />
    </g>
  );
}

function PartShape({ part, ghost = false, selected = false }) {
  let shape;
  if (part.type === "strip") shape = <StripShape part={part} ghost={ghost} />;
  else if (part.type === "slottedStrip") shape = <SlottedStripShape part={part} ghost={ghost} />;
  else if (part.type === "motor") shape = <MotorShape part={part} ghost={ghost} />;
  else if (part.type === "bell") shape = <BellShape part={part} ghost={ghost} />;
  else if (part.type === "stamp") shape = <StampShape part={part} ghost={ghost} />;
  else shape = <PolyShape part={part} ghost={ghost} />;
  return (
    <g transform={`translate(${part.x * GRID},${part.y * GRID}) rotate(${part.rotation})`}>
      {selected && !ghost && <SelectionHalo part={part} />}
      {shape}
    </g>
  );
}

function SelectionHalo({ part }) {
  const holes = getLocalHoles(part);
  const maxD = Math.max(...holes.map(h => Math.hypot(h.x, h.y)));
  const r = (maxD + 0.6) * GRID;
  return (
    <circle
      cx={0} cy={0} r={r}
      fill="none"
      stroke={COLORS.select}
      strokeWidth={SELECT_STROKE}
      strokeDasharray="6 4"
      opacity={0.9}
    />
  );
}

function rotationHandleLocal(part) {
  const holes = getLocalHoles(part);
  if (part.type === "strip" || part.type === "slottedStrip") {
    const pivotIdx = part.pivotHoleIdx ?? 0;
    const pivotHole = holes[pivotIdx] ?? { x: 0, y: 0 };
    const otherIdx = pivotIdx === 0 ? holes.length - 1 : 0;
    const otherHole = holes[otherIdx] ?? { x: 1, y: 0 };
    const dx = otherHole.x - pivotHole.x, dy = otherHole.y - pivotHole.y;
    const len = Math.hypot(dx, dy);
    if (len < 0.001) return { x: 1.1, y: 0 };
    // Place handle 1.1 grid units past the far end from the pivot
    return { x: otherHole.x + (dx / len) * 1.1, y: otherHole.y + (dy / len) * 1.1 };
  }
  const maxD = Math.max(...holes.map(h => Math.hypot(h.x, h.y)));
  return { x: maxD + 1.1, y: 0 };
}

// ---------- Icon glyphs for joints ----------
function PivotGlyph({ size = 18 }) {
  return (
    <svg width={size} height={size} viewBox="-10 -10 20 20">
      <circle cx="0" cy="0" r="8" fill={COLORS.pivot} stroke={COLORS.partEdge} strokeWidth="1.4" />
      <circle cx="0" cy="0" r="2.3" fill={COLORS.partEdge} />
    </svg>
  );
}
// White/currentColor version for toolbar use
function PivotIcon({ size = 18 }) {
  return (
    <svg width={size} height={size} viewBox="-10 -10 20 20">
      <circle cx="0" cy="0" r="7.5" fill="none" stroke="currentColor" strokeWidth="2" />
      <circle cx="0" cy="0" r="2.5" fill="currentColor" />
    </svg>
  );
}
function WeldGlyph({ size = 18 }) {
  return (
    <svg width={size} height={size} viewBox="-10 -10 20 20">
      <rect x="-7.5" y="-7.5" width="15" height="15" rx="2" fill={COLORS.weld} stroke={COLORS.partEdge} strokeWidth="1.4" />
      <path d="M -4 -4 L 4 4 M -4 4 L 4 -4" stroke={COLORS.partEdge} strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}
function GroundGlyph({ size = 18 }) {
  return (
    <svg width={size} height={size} viewBox="-10 -10 20 20">
      <circle cx="0" cy="0" r="8" fill={COLORS.ground} stroke={COLORS.partEdge} strokeWidth="1.4" />
      <path d="M -5 4 L 5 4 M -3 7 L 3 7 M -1 10 L 1 10" stroke={COLORS.partEdge} strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

// ---------- Simulation ----------

function buildConstraintMap(parts, joints) {
  const map = new Map();
  for (const joint of joints) {
    const entries = [];
    for (const partId of joint.partIds) {
      const part = parts.find(p => p.id === partId);
      if (!part) continue;
      const wh = worldHoles(part);
      let bestIdx = -1, bestDist = 0.4;
      for (let i = 0; i < wh.length; i++) {
        const d = Math.hypot(wh[i].x - joint.x, wh[i].y - joint.y);
        if (d < bestDist) { bestDist = d; bestIdx = i; }
      }
      if (bestIdx >= 0) {
        const isSlot = part.type === "slottedStrip" && bestIdx > 0 && bestIdx < part.size - 1;
        entries.push({ partId, holeIdx: bestIdx, isSlot });
      } else if (part.type === "slottedStrip") {
        // Joint was placed on the slot body axis (not at a discrete hole) — still a slot constraint
        const θr = part.rotation * Math.PI / 180;
        const cosθ = Math.cos(θr), sinθ = Math.sin(θr);
        const relX = joint.x - part.x, relY = joint.y - part.y;
        const along = relX * cosθ + relY * sinθ;
        const perp = Math.abs(-relX * sinθ + relY * cosθ);
        if (along >= 0.4 && along <= part.size - 1.4 && perp < 0.6) {
          entries.push({ partId, holeIdx: 0, isSlot: true });
        }
      }
    }
    map.set(joint.id, entries);
  }
  return map;
}

function buildWeldTransforms(parts, joints) {
  const transforms = [];
  for (const joint of joints) {
    if (joint.kind !== "weld") continue;
    if (joint.partIds.length < 2) continue;
    const [idA, idB] = joint.partIds;
    const pA = parts.find(p => p.id === idA);
    const pB = parts.find(p => p.id === idB);
    if (!pA || !pB) continue;
    const relRotDeg = pB.rotation - pA.rotation;
    const worldOff = { x: pB.x - pA.x, y: pB.y - pA.y };
    const localOff = rotate(worldOff, -pA.rotation);
    transforms.push({ partIdA: idA, partIdB: idB, relRotDeg, localOffX: localOff.x, localOffY: localOff.y });
  }
  return transforms;
}

function simWorldHole(part, holeIdx) {
  const lh = getLocalHoles(part)[holeIdx];
  if (!lh) return { x: part.x, y: part.y };
  const r = rotate(lh, part.rotation);
  return { x: part.x + r.x, y: part.y + r.y };
}

// Apply a single positional constraint to a rigid body:
// moves and rotates the part so that its `holeIdx` ends up exactly at (targetX, targetY).
// Uses the angular-impulse formula so the rotation is correct for the rigid body.
function applyPositionConstraint(part, holeIdx, targetX, targetY) {
  const lh = getLocalHoles(part)[holeIdx];
  if (!lh) return part;
  const r = rotate(lh, part.rotation);             // radius vector (center → hole) in world space
  const ex = targetX - (part.x + r.x);
  const ey = targetY - (part.y + r.y);
  if (Math.abs(ex) < 1e-9 && Math.abs(ey) < 1e-9) return part;
  // Angular correction: dθ = (r × e) / |r|²
  const rSq = r.x * r.x + r.y * r.y;
  const dθRad = rSq > 0.001 ? (r.x * ey - r.y * ex) / rSq : 0;
  const newRotDeg = part.rotation + dθRad * 180 / Math.PI;
  // After rotation, re-pin via translation so the hole is exactly at target
  const newR = rotate(lh, newRotDeg);
  return { ...part, rotation: newRotDeg, x: targetX - newR.x, y: targetY - newR.y };
}

const SOLVER_ITERATIONS = 60;

// Returns the two intersection points of circle(ax,ay,ra) and circle(bx,by,rb), or null if none.
function circleCircleIntersect(ax, ay, ra, bx, by, rb) {
  const dx = bx - ax, dy = by - ay;
  const d = Math.hypot(dx, dy);
  if (d > ra + rb + 0.01 || d < Math.abs(ra - rb) - 0.01 || d < 1e-9) return null;
  const a = (ra * ra - rb * rb + d * d) / (2 * d);
  const h = Math.sqrt(Math.max(0, ra * ra - a * a));
  const mx = ax + a * dx / d, my = ay + a * dy / d;
  return [
    { x: mx + h * dy / d, y: my - h * dx / d },
    { x: mx - h * dy / d, y: my + h * dx / d },
  ];
}

// General kinematic solver: walks motor-driven chains of arbitrary depth,
// then cascades through solved grounded intermediates to propagate further.
function solveKinematicChains(parts, joints, constraintMap, groundByPart) {
  const solvedIds = new Set();

  const localLen = (part, hA, hB) => {
    const hl = getLocalHoles(part);
    return Math.hypot(hl[hA].x - hl[hB].x, hl[hA].y - hl[hB].y);
  };
  const closest = (sols, ref) => {
    const d0 = Math.hypot(sols[0].x - ref.x, sols[0].y - ref.y);
    const d1 = Math.hypot(sols[1].x - ref.x, sols[1].y - ref.y);
    return d0 <= d1 ? sols[0] : sols[1];
  };

  // Index: partId → all non-ground pivot joints containing that part
  const pjByPart = new Map();
  for (const j of joints) {
    if (j.kind === "ground") continue;
    const cm = constraintMap.get(j.id);
    if (!cm) continue;
    for (const e of cm) {
      if (!pjByPart.has(e.partId)) pjByPart.set(e.partId, []);
      pjByPart.get(e.partId).push({ joint: j, entry: e });
    }
  }

  // Parts with >1 ground joint are fully fixed — kinematic solver must not move them
  const groundCount = new Map();
  for (const j of joints) {
    if (j.kind !== "ground") continue;
    const cm = constraintMap.get(j.id);
    if (!cm) continue;
    for (const e of cm) groundCount.set(e.partId, (groundCount.get(e.partId) || 0) + 1);
  }
  const fullyFixed = new Set([...groundCount.entries()].filter(([, c]) => c > 1).map(([id]) => id));

  // Walk and solve a linear chain starting at (startPartId, inHoleIdx) driven from position A.
  // Stops when it reaches a grounded terminal. visitedIds prevents cycles.
  function trySolveChain(startPartId, inHoleIdx, A, visitedIds) {
    const chain = []; // [{ part, inHoleIdx, outHoleIdx }]
    let curId = startPartId;
    let curInHole = inHoleIdx;
    const visited = new Set(visitedIds);
    visited.add(curId);

    for (let depth = 0; depth < 8; depth++) {
      const cur = parts.find(p => p.id === curId);
      if (!cur) break;

      if (groundByPart.has(curId)) {
        if (fullyFixed.has(curId)) break; // over-constrained, abort — PBD handles it
        chain.push({ part: cur, inHoleIdx: curInHole, outHoleIdx: groundByPart.get(curId).holeIdx });
        break;
      }

      // Find first valid outgoing pivot joint from this part (not the incoming hole)
      let moved = false;
      for (const { joint: pj, entry: pe } of (pjByPart.get(curId) || [])) {
        if (pe.holeIdx === curInHole) continue;
        const cm2 = constraintMap.get(pj.id);
        if (!cm2) continue;
        const next = cm2.find(e => e.partId !== curId);
        if (!next || visited.has(next.partId)) continue;
        chain.push({ part: cur, inHoleIdx: curInHole, outHoleIdx: pe.holeIdx });
        visited.add(next.partId);
        curId = next.partId;
        curInHole = next.holeIdx;
        moved = true;
        break;
      }
      if (!moved) break;
    }

    const n = chain.length;
    if (n === 0 || !groundByPart.has(chain[n - 1].part.id)) return false;

    const gEntry = groundByPart.get(chain[n - 1].part.id);
    const G = { x: gEntry.x, y: gEntry.y };
    const L = chain.map(cp => localLen(cp.part, cp.inHoleIdx, cp.outHoleIdx));
    // K[i] = free pivot between link i and link i+1 (i = 0..n-2)
    const K = chain.slice(0, n - 1).map(cp => simWorldHole(cp.part, cp.outHoleIdx));

    if (n === 1) {
      // Driving point A directly orients a grounded terminal — one-shot
      const idx = parts.findIndex(p => p.id === chain[0].part.id);
      if (idx < 0) return false;
      parts[idx] = solveGroundedPart(chain[0].part, chain[0].outHoleIdx, G.x, G.y, chain[0].inHoleIdx, A.x, A.y);
      solvedIds.add(chain[0].part.id);
      return true;
    }

    if (n === 2) {
      // Direct cci — one-shot, no iteration needed
      const sols = circleCircleIntersect(A.x, A.y, L[0], G.x, G.y, L[1]);
      if (!sols) return false;
      K[0] = closest(sols, K[0]);
    } else {
      // Gauss-Seidel for n ≥ 3 links
      let ok = true;
      for (let it = 0; it < 24; it++) {
        for (let i = 0; i < n - 1; i++) {
          const prev = i === 0 ? A : K[i - 1];
          const next = i === n - 2 ? G : K[i + 1];
          const sols = circleCircleIntersect(prev.x, prev.y, L[i], next.x, next.y, L[i + 1]);
          if (!sols) { ok = false; break; }
          K[i] = closest(sols, K[i]);
        }
        if (!ok) break;
      }
      if (!ok) return false;
    }

    // Apply solved pivot positions to all parts
    const pivots = [A, ...K, G]; // n+1 boundary points
    for (let i = 0; i < n; i++) {
      const cp = chain[i];
      const idx = parts.findIndex(p => p.id === cp.part.id);
      if (idx < 0) continue;
      const pIn = pivots[i], pOut = pivots[i + 1];
      parts[idx] = i < n - 1
        ? solveGroundedPart(cp.part, cp.inHoleIdx, pIn.x, pIn.y, cp.outHoleIdx, pOut.x, pOut.y)
        : solveGroundedPart(cp.part, cp.outHoleIdx, G.x, G.y, cp.inHoleIdx, pIn.x, pIn.y);
      solvedIds.add(cp.part.id);
    }
    return true;
  }

  // Phase 1: solve chains driven directly by motors
  for (const motorPart of parts) {
    if (motorPart.type !== "motor") continue;
    for (const { entry: me, joint: mj } of (pjByPart.get(motorPart.id) || [])) {
      const cm0 = constraintMap.get(mj.id);
      if (!cm0 || cm0.length < 2) continue;
      const crankE = cm0.find(e => e.partId !== motorPart.id);
      if (!crankE) continue;
      const A = simWorldHole(motorPart, me.holeIdx);
      trySolveChain(crankE.partId, crankE.holeIdx, A, [motorPart.id]);
    }
  }

  // Phase 2: cascade — solved grounded parts drive further downstream chains
  let changed = true;
  while (changed) {
    changed = false;
    for (const partId of [...solvedIds]) {
      if (!groundByPart.has(partId) || fullyFixed.has(partId)) continue;
      const solved = parts.find(p => p.id === partId);
      if (!solved) continue;
      const gHole = groundByPart.get(partId).holeIdx;
      for (const { joint: pj, entry: pe } of (pjByPart.get(partId) || [])) {
        if (pe.holeIdx === gHole) continue; // ignore the ground-pin hole
        const cm2 = constraintMap.get(pj.id);
        if (!cm2) continue;
        const next = cm2.find(e => e.partId !== partId);
        if (!next || solvedIds.has(next.partId)) continue;
        const A = simWorldHole(solved, pe.holeIdx);
        const before = solvedIds.size;
        trySolveChain(next.partId, next.holeIdx, A, [partId]);
        if (solvedIds.size > before) changed = true;
      }
    }
  }

  return solvedIds;
}

// Exact one-shot solver for a part that has a ground pin AND a pivot constraint.
// Rotates the part around its ground hole to point toward pivotTarget, then
// translates to re-pin the ground hole. Both constraints satisfied simultaneously.
function solveGroundedPart(part, groundHoleIdx, groundX, groundY, pivotHoleIdx, pivotTX, pivotTY) {
  const localHoles = getLocalHoles(part);
  const gLH = localHoles[groundHoleIdx];
  const pLH = localHoles[pivotHoleIdx];
  if (!gLH || !pLH) return part;
  const dLocal = { x: pLH.x - gLH.x, y: pLH.y - gLH.y };
  if (Math.hypot(dLocal.x, dLocal.y) < 0.01) return part;
  const dWorld = { x: pivotTX - groundX, y: pivotTY - groundY };
  const newRotRad = Math.atan2(dWorld.y, dWorld.x) - Math.atan2(dLocal.y, dLocal.x);
  const newRotDeg = newRotRad * 180 / Math.PI;
  const rG = rotate(gLH, newRotDeg);
  return { ...part, rotation: newRotDeg, x: groundX - rG.x, y: groundY - rG.y };
}

function stepSimulation(simParts, joints, constraintMap, weldTransforms, dt) {
  const parts = simParts.map(p => ({ ...p }));

  // Pre-build ground lookup: partId → last {holeIdx, x, y} (for kinematic solver)
  // Also build groundsByPart: partId → ALL [{holeIdx, x, y}] (for fully-fixed snapping)
  const groundByPart = new Map();
  const groundsByPart = new Map();
  for (const joint of joints) {
    if (joint.kind !== "ground") continue;
    const cm = constraintMap.get(joint.id);
    if (!cm) continue;
    for (const entry of cm) {
      groundByPart.set(entry.partId, { holeIdx: entry.holeIdx, x: joint.x, y: joint.y });
      if (!groundsByPart.has(entry.partId)) groundsByPart.set(entry.partId, []);
      groundsByPart.get(entry.partId).push({ holeIdx: entry.holeIdx, x: joint.x, y: joint.y });
    }
  }

  // Parts with 2+ ground joints are fully fixed — solve both position AND rotation
  const fullyFixed2 = new Set(
    [...groundsByPart.entries()].filter(([, gs]) => gs.length > 1).map(([id]) => id)
  );
  const snapFullyFixed = () => {
    for (const partId of fullyFixed2) {
      const gs = groundsByPart.get(partId);
      if (!gs || gs.length < 2) continue;
      const idx = parts.findIndex(p => p.id === partId);
      if (idx < 0) continue;
      parts[idx] = solveGroundedPart(parts[idx], gs[0].holeIdx, gs[0].x, gs[0].y, gs[1].holeIdx, gs[1].x, gs[1].y);
    }
  };
  snapFullyFixed();

  // Sort joints so motor-connected pivots run first each iteration,
  // ensuring downstream constraints always see fresh motor-driven positions.
  const sortedJoints = [...joints].sort((a, b) => {
    const motorConnected = (j) => j.kind !== "ground" && j.partIds.some(id => {
      const p = parts.find(q => q.id === id);
      return p?.type === "motor";
    });
    const aMotor = motorConnected(a);
    const bMotor = motorConnected(b);
    if (aMotor && !bMotor) return -1;
    if (!aMotor && bMotor) return 1;
    // grounds last
    if (a.kind === "ground" && b.kind !== "ground") return 1;
    if (a.kind !== "ground" && b.kind === "ground") return -1;
    return 0;
  });

  // Step 1: Advance motors
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (part.type !== "motor") continue;
    const motorSpeed = (part.speed ?? MOTOR_SPEED_DEG) * (part.direction ?? 1);
    const newRot = part.rotation + motorSpeed * dt;
    const g = groundByPart.get(part.id);
    let pivotX = part.x, pivotY = part.y, pivotHoleIdx = 0;
    if (g) { pivotX = g.x; pivotY = g.y; pivotHoleIdx = g.holeIdx; }
    const lh = getLocalHoles(part)[pivotHoleIdx] ?? { x: 0, y: 0 };
    const r = rotate(lh, newRot);
    parts[i] = { ...part, rotation: newRot, x: pivotX - r.x, y: pivotY - r.y };
  }

  // Step 1b: Exact kinematic solve for motor→free→grounded chains — no drift, no iteration
  const kinematicallySolvedIds = solveKinematicChains(parts, joints, constraintMap, groundByPart);

  // Parts directly connected to a motor (the cranks): treated as authoritative in PBD
  const motorConnectedIds = new Set();
  for (const j of joints) {
    if (j.kind === "ground") continue;
    const cm = constraintMap.get(j.id);
    if (!cm || cm.length < 2) continue;
    const hasMotor = cm.some(e => parts.find(p => p.id === e.partId)?.type === "motor");
    if (hasMotor) {
      for (const e of cm) {
        if (parts.find(p => p.id === e.partId)?.type !== "motor") motorConnectedIds.add(e.partId);
      }
    }
  }
  // Parts solved analytically are also authoritative — PBD must not override them
  for (const id of kinematicallySolvedIds) motorConnectedIds.add(id);

  // Step 2: Constraint iterations
  for (let iter = 0; iter < SOLVER_ITERATIONS; iter++) {
    for (const joint of sortedJoints) {
      const cm = constraintMap.get(joint.id);
      if (!cm || cm.length === 0) continue;

      if (joint.kind === "ground") {
        const entry = cm[0];
        if (fullyFixed2.has(entry.partId)) continue; // handled by snapFullyFixed
        const idx = parts.findIndex(p => p.id === entry.partId);
        if (idx < 0 || parts[idx].type === "motor") continue;
        const p = parts[idx];
        const lh = getLocalHoles(p)[entry.holeIdx];
        if (!lh) continue;
        const r = rotate(lh, p.rotation);
        parts[idx] = { ...p, x: joint.x - r.x, y: joint.y - r.y };

      } else if (cm.length >= 2) {
        const [entA, entB] = cm;
        const idxA = parts.findIndex(p => p.id === entA.partId);
        const idxB = parts.findIndex(p => p.id === entB.partId);
        if (idxA < 0 || idxB < 0) continue;

        const aFixed = parts[idxA].type === "motor";
        const bFixed = parts[idxB].type === "motor";
        if (aFixed && bFixed) continue;

        if (entA.isSlot || entB.isSlot) {
          // Line (prismatic) constraint: the other part's hole slides along the slot strip's axis
          const [slotEntry, slotIdx, otherEntry, otherIdx] = entA.isSlot
            ? [entA, idxA, entB, idxB]
            : [entB, idxB, entA, idxA];
          const S = parts[slotIdx];
          const θr = S.rotation * Math.PI / 180;
          const cosθ = Math.cos(θr), sinθ = Math.sin(θr);
          const whOther = simWorldHole(parts[otherIdx], otherEntry.holeIdx);
          const relX = whOther.x - S.x, relY = whOther.y - S.y;
          const s = relX * cosθ + relY * sinθ;
          const e = -relX * sinθ + relY * cosθ;
          const projX = S.x + s * cosθ, projY = S.y + s * sinθ;
          const sFixed = S.type === "motor" || fullyFixed2.has(slotEntry.partId);
          if (!sFixed) {
            if (groundByPart.has(slotEntry.partId)) {
              // Single-ground slotted strip: rotate around the ground anchor to align slot with pin
              const gS = groundByPart.get(slotEntry.partId);
              const gLH = getLocalHoles(S)[gS.holeIdx];
              const dLen = Math.hypot(whOther.x - gS.x, whOther.y - gS.y);
              if (gLH && dLen > 0.01) {
                // s is along-axis position from hole 0; gLH.x is ground hole's local x
                const newRotRad = Math.atan2(whOther.y - gS.y, whOther.x - gS.x) + (s < gLH.x ? Math.PI : 0);
                const newRotDeg = newRotRad * 180 / Math.PI;
                const rG = rotate(gLH, newRotDeg);
                parts[slotIdx] = { ...S, rotation: newRotDeg, x: gS.x - rG.x, y: gS.y - rG.y };
              }
            } else {
              parts[slotIdx] = { ...S, x: S.x - e * sinθ, y: S.y + e * cosθ };
            }
          }
          // Recompute projection with possibly-updated slot strip
          const S2 = parts[slotIdx];
          const θr2 = S2.rotation * Math.PI / 180;
          const cosθ2 = Math.cos(θr2), sinθ2 = Math.sin(θr2);
          const relX2 = whOther.x - S2.x, relY2 = whOther.y - S2.y;
          const s2 = relX2 * cosθ2 + relY2 * sinθ2;
          const projX2 = S2.x + s2 * cosθ2, projY2 = S2.y + s2 * sinθ2;
          if (parts[otherIdx].type !== "motor") {
            const gOther = groundByPart.get(otherEntry.partId);
            parts[otherIdx] = gOther
              ? solveGroundedPart(parts[otherIdx], gOther.holeIdx, gOther.x, gOther.y, otherEntry.holeIdx, projX2, projY2)
              : applyPositionConstraint(parts[otherIdx], otherEntry.holeIdx, projX2, projY2);
          }
        } else {
          const whA = simWorldHole(parts[idxA], entA.holeIdx);
          const whB = simWorldHole(parts[idxB], entB.holeIdx);
          const aGrounded = groundByPart.has(entA.partId);
          const bGrounded = groundByPart.has(entB.partId);
          const gA = groundByPart.get(entA.partId);
          const gB = groundByPart.get(entB.partId);

          if (aFixed) {
            // Motor drives A: pull B toward A's hole — skip if B was analytically solved this frame
            if (!motorConnectedIds.has(entB.partId)) {
              parts[idxB] = gB
                ? solveGroundedPart(parts[idxB], gB.holeIdx, gB.x, gB.y, entB.holeIdx, whA.x, whA.y)
                : applyPositionConstraint(parts[idxB], entB.holeIdx, whA.x, whA.y);
            }
          } else if (bFixed) {
            // Motor drives B: pull A toward B's hole — skip if A was analytically solved this frame
            if (!motorConnectedIds.has(entA.partId)) {
              parts[idxA] = gA
                ? solveGroundedPart(parts[idxA], gA.holeIdx, gA.x, gA.y, entA.holeIdx, whB.x, whB.y)
                : applyPositionConstraint(parts[idxA], entA.holeIdx, whB.x, whB.y);
            }
          } else if (bGrounded && !aGrounded) {
            // If B was analytically solved, don't re-rotate it — just pull A toward B's current hole.
            if (!motorConnectedIds.has(entB.partId)) {
              parts[idxB] = solveGroundedPart(parts[idxB], gB.holeIdx, gB.x, gB.y, entB.holeIdx, whA.x, whA.y);
            }
            if (!motorConnectedIds.has(entA.partId)) {
              const newWhB = simWorldHole(parts[idxB], entB.holeIdx);
              parts[idxA] = applyPositionConstraint(parts[idxA], entA.holeIdx, newWhB.x, newWhB.y);
            }
          } else if (aGrounded && !bGrounded) {
            // If A was analytically solved, don't re-rotate it — just pull B toward A's current hole.
            if (!motorConnectedIds.has(entA.partId)) {
              parts[idxA] = solveGroundedPart(parts[idxA], gA.holeIdx, gA.x, gA.y, entA.holeIdx, whB.x, whB.y);
            }
            if (!motorConnectedIds.has(entB.partId)) {
              const newWhA = simWorldHole(parts[idxA], entA.holeIdx);
              parts[idxB] = applyPositionConstraint(parts[idxB], entB.holeIdx, newWhA.x, newWhA.y);
            }
          } else if (aGrounded && bGrounded) {
            // Both parts grounded — exact circle-circle intersection
            const locsA = getLocalHoles(parts[idxA]);
            const locsB = getLocalHoles(parts[idxB]);
            const rA = Math.hypot(locsA[entA.holeIdx].x - locsA[gA.holeIdx].x, locsA[entA.holeIdx].y - locsA[gA.holeIdx].y);
            const rB = Math.hypot(locsB[entB.holeIdx].x - locsB[gB.holeIdx].x, locsB[entB.holeIdx].y - locsB[gB.holeIdx].y);
            const sols = circleCircleIntersect(gA.x, gA.y, rA, gB.x, gB.y, rB);
            if (sols) {
              const d0 = Math.hypot(sols[0].x - whA.x, sols[0].y - whA.y);
              const d1 = Math.hypot(sols[1].x - whA.x, sols[1].y - whA.y);
              const tgt = d0 <= d1 ? sols[0] : sols[1];
              parts[idxA] = solveGroundedPart(parts[idxA], gA.holeIdx, gA.x, gA.y, entA.holeIdx, tgt.x, tgt.y);
              parts[idxB] = solveGroundedPart(parts[idxB], gB.holeIdx, gB.x, gB.y, entB.holeIdx, tgt.x, tgt.y);
            }
          } else {
            // Both free: motor-connected part is authoritative — other follows it exactly
            const aMC = motorConnectedIds.has(entA.partId);
            const bMC = motorConnectedIds.has(entB.partId);
            if (aMC && !bMC) {
              parts[idxB] = applyPositionConstraint(parts[idxB], entB.holeIdx, whA.x, whA.y);
            } else if (bMC && !aMC) {
              parts[idxA] = applyPositionConstraint(parts[idxA], entA.holeIdx, whB.x, whB.y);
            } else {
              const tX = (whA.x + whB.x) / 2;
              const tY = (whA.y + whB.y) / 2;
              parts[idxA] = applyPositionConstraint(parts[idxA], entA.holeIdx, tX, tY);
              parts[idxB] = applyPositionConstraint(parts[idxB], entB.holeIdx, tX, tY);
            }
          }
        }
      }
    }

    // Weld transforms
    const pbMap = new Map(parts.map(p => [p.id, p]));
    for (const wt of weldTransforms) {
      const pA = pbMap.get(wt.partIdA);
      if (!pA) continue;
      const bIdx = parts.findIndex(p => p.id === wt.partIdB);
      if (bIdx < 0) continue;
      const wOff = rotate({ x: wt.localOffX, y: wt.localOffY }, pA.rotation);
      parts[bIdx] = { ...parts[bIdx], x: pA.x + wOff.x, y: pA.y + wOff.y, rotation: pA.rotation + wt.relRotDeg };
    }
  }

  // Re-snap fully-fixed parts after PBD — prevents any accumulated drift
  snapFullyFixed();

  // Jam detection: check all pivot joints where either part is motor-connected.
  // This catches disconnections anywhere in the driven chain, not just at the motor joint.
  let jammed = false;
  for (const joint of joints) {
    if (joint.kind === "ground") continue;
    const cm = constraintMap.get(joint.id);
    if (!cm || cm.length < 2) continue;
    const [entA, entB] = cm;
    const eitherMC = motorConnectedIds.has(entA.partId) || motorConnectedIds.has(entB.partId);
    if (!eitherMC) continue;
    const whA = simWorldHole(parts.find(p => p.id === entA.partId) ?? simParts.find(p => p.id === entA.partId), entA.holeIdx);
    const whB = simWorldHole(parts.find(p => p.id === entB.partId) ?? simParts.find(p => p.id === entB.partId), entB.holeIdx);
    if (whA && whB && Math.hypot(whA.x - whB.x, whA.y - whB.y) > 0.5) {
      jammed = true;
      break;
    }
  }

  if (jammed) {
    return { parts: simParts.map(p => ({ ...p })), jammed: true };
  }
  return { parts, jammed: false };
}

// ---------- Main component ----------
export default function ZineMachine() {
  const [st, dispatch] = useReducer(reducer, initial);
  const svgRef = useRef(null);
  const [camera, setCamera] = useState({ x: SECTION_COLS * GRID, y: SECTION_ROWS * GRID });
  const cameraRef = useRef(camera);
  useEffect(() => { cameraRef.current = camera; }, [camera]);
  const [zoom, setZoom] = useState(1);
  const zoomRef = useRef(1);
  useEffect(() => { zoomRef.current = zoom; }, [zoom]);
  const [spaceHeld, setSpaceHeld] = useState(false);
  const spaceHeldRef = useRef(false);
  const [elastic, setElastic] = useState(null); // { origin:{x,y}, current:{x,y} } for two-click strip placement
  const [hoverHole, setHoverHole] = useState(null); // {x, y} in grid coords
  const [drag, setDrag] = useState(null);
  // drag: { kind: 'move' | 'rotate', id, startX, startY, origPart }
  const [snapHint, setSnapHint] = useState(null); // {x, y} world grid coords of target hole
  const [ctxMenu, setCtxMenu] = useState(null);   // { x, y, part } client coords
  const [jointSnap, setJointSnap] = useState(null); // {x, y} nearest part hole when joint tool active
  const [selectedJointId, setSelectedJointId] = useState(null);
  const [jointCtxMenu, setJointCtxMenu] = useState(null);
  const [jointDrag, setJointDrag] = useState(null);
  const [hoverPivotHole, setHoverPivotHole] = useState(null);

  // Simulation state
  const [simParts, setSimParts] = useState(null);
  const [simPaused, setSimPaused] = useState(false);
  const [simJammed, setSimJammed] = useState(false);
  const [selRect, setSelRect] = useState(null);       // { x1,y1,x2,y2 } grid coords
  const [multiSelectedIds, setMultiSelectedIds] = useState(new Set());
  const multiSelectedIdsRef = useRef(new Set());
  useEffect(() => { multiSelectedIdsRef.current = multiSelectedIds; }, [multiSelectedIds]);
  const [hoverRotHandle, setHoverRotHandle] = useState(false);
  const simRef = useRef(null);
  const rafRef = useRef(null);
  const lastTimeRef = useRef(null);
  const pausedRef = useRef(false);
  const triggeredBellsRef = useRef(new Set());
  const stampWeldRef = useRef(null); // { partId, holeIdx } set during stamp drag, applied on drop

  useEffect(() => { pausedRef.current = simPaused; }, [simPaused]);
  useEffect(() => { setHoverRotHandle(false); }, [st.selectedId]);

  // Auto-save to localStorage on every design change
  useEffect(() => {
    try {
      localStorage.setItem("zine_machine_v4", JSON.stringify({ parts: st.parts, joints: st.joints, nextId: st.nextId }));
    } catch(e) {}
  }, [st.parts, st.joints, st.nextId]);

  useEffect(() => {
    if (st.mode !== "play") {
      if (rafRef.current) { cancelAnimationFrame(rafRef.current); rafRef.current = null; }
      lastTimeRef.current = null;
      setSimParts(null);
      setSimPaused(false);
      setSimJammed(false);
      triggeredBellsRef.current.clear();
      return;
    }
    const initParts = st.parts.map(p => ({ ...p }));
    const initJoints = [...st.joints];
    const cm = buildConstraintMap(initParts, initJoints);
    const wt = buildWeldTransforms(initParts, initJoints);
    let cur = initParts;
    simRef.current = { constraintMap: cm, weldTransforms: wt, joints: initJoints, getCur: () => cur };
    lastTimeRef.current = null;
    const loop = (time) => {
      try {
        if (pausedRef.current) {
          lastTimeRef.current = null;
          rafRef.current = requestAnimationFrame(loop);
          return;
        }
        if (!lastTimeRef.current) lastTimeRef.current = time;
        const dt = Math.min((time - lastTimeRef.current) / 1000, 0.05);
        lastTimeRef.current = time;
        const { parts: nextParts, jammed } = stepSimulation(cur, initJoints, cm, wt, dt);
        cur = nextParts;
        // Weld stamps to their host part holes
        cur = cur.map(stamp => {
          if (stamp.type !== "stamp" || !stamp.weldedTo) return stamp;
          const host = cur.find(p => p.id === stamp.weldedTo.partId);
          if (!host) return stamp;
          const wh = worldHoles(host)[stamp.weldedTo.holeIdx];
          if (!wh) return stamp;
          const rotOffset = stamp.weldedTo.rotationOffset ?? 0;
          return { ...stamp, x: wh.x, y: wh.y, rotation: (host.rotation || 0) + rotOffset };
        });
        setSimJammed(jammed);
        // Bell collision detection
        const bellParts = initParts.filter(p => p.type === "bell");
        for (const bell of bellParts) {
          // Bell body center is 0.36 grid units above pivot in bell-local space
          const bellRad = (bell.rotation || 0) * Math.PI / 180;
          const bellCx = bell.x + 0.36 * Math.sin(bellRad);
          const bellCy = bell.y - 0.36 * Math.cos(bellRad);
          const inBell = (pt) => Math.hypot(pt.x - bellCx, pt.y - bellCy) < 1.3;
          let anyHit = false;
          for (const p of cur) {
            if (p.type === "bell") continue;
            const checkPoints = [{ x: p.x, y: p.y }, ...worldHoles(p)];
            if (p.type === "stamp") {
              const tipDir = p.glyph === "☜" ? -1 : 1;
              const tip = rotate({ x: tipDir * 1.5, y: 0 }, p.rotation || 0);
              checkPoints.push({ x: p.x + tip.x, y: p.y + tip.y });
            }
            for (const pt of checkPoints) {
              if (inBell(pt)) { anyHit = true; break; }
            }
            if (anyHit) break;
          }
          if (anyHit && !triggeredBellsRef.current.has(bell.id)) {
            playNote(NOTES[bell.note ?? 'A4']);
            triggeredBellsRef.current.add(bell.id);
          } else if (!anyHit) {
            triggeredBellsRef.current.delete(bell.id);
          }
        }
        setSimParts([...cur]);
        rafRef.current = requestAnimationFrame(loop);
      } catch (err) {
        console.error("[sim] crash:", err);
      }
    };
    rafRef.current = requestAnimationFrame(loop);
    return () => {
      if (rafRef.current) { cancelAnimationFrame(rafRef.current); rafRef.current = null; }
      lastTimeRef.current = null;
    };
  }, [st.mode]); // eslint-disable-line react-hooks/exhaustive-deps

  const boardW = (COLS - 1 + BOARD_PAD * 2) * GRID;
  const boardH = (ROWS - 1 + BOARD_PAD * 2) * GRID;

  const handleZoom = useCallback((delta) => {
    const svg = svgRef.current;
    const newZoom = Math.max(0.5, Math.min(1.5, zoomRef.current + delta));
    if (newZoom === zoomRef.current) return;
    if (svg) {
      const rect = svg.getBoundingClientRect();
      const cx = rect.width / 2, cy = rect.height / 2;
      const ratio = newZoom / zoomRef.current;
      setCamera(prev => ({
        x: prev.x * ratio + cx * (ratio - 1),
        y: prev.y * ratio + cy * (ratio - 1),
      }));
    }
    setZoom(newZoom);
  }, []);

  // ---- Pointer utilities ----
  const pointerToGrid = useCallback((e) => {
    const svg = svgRef.current;
    if (!svg) return null;
    const rect = svg.getBoundingClientRect();
    const z = zoomRef.current;
    return {
      x: (e.clientX - rect.left + cameraRef.current.x) / (GRID * z),
      y: (e.clientY - rect.top  + cameraRef.current.y) / (GRID * z),
    };
  }, []);

  const snapToBoard = (gx, gy) => ({
    x: Math.max(0, Math.min(COLS - 1, Math.round(gx))),
    y: Math.max(0, Math.min(ROWS - 1, Math.round(gy))),
  });

  // ---- Board move handler: hover + drag update ----
  const handleSvgMove = (e) => {
    // Pan mode: update camera directly, no grid coords needed
    if (drag?.kind === "pan") {
      setCamera({
        x: drag.startCamera.x - (e.clientX - drag.startX),
        y: drag.startCamera.y - (e.clientY - drag.startY),
      });
      return;
    }
    // Spacebar pan
    if (spaceHeldRef.current && drag?.kind === "space-pan") {
      setCamera({
        x: drag.startCamera.x - (e.clientX - drag.startX),
        y: drag.startCamera.y - (e.clientY - drag.startY),
      });
      return;
    }

    const g = pointerToGrid(e);
    if (!g) return;

    // Update elastic strip ghost destination
    if (elastic) {
      setElastic(prev => prev ? { ...prev, current: { x: g.x, y: g.y } } : null);
    }

    // When placing, snap hover to nearby part holes too
    let holePos = snapToBoard(g.x, g.y);
    if (st.tool === "place" && st.parts.length > 0) {
      let bestDist = 0.9;
      for (const other of st.parts) {
        for (const th of worldHoles(other)) {
          const d = Math.hypot(g.x - th.x, g.y - th.y);
          if (d < bestDist) { bestDist = d; holePos = { x: th.x, y: th.y }; }
        }
        if (other.type === "slottedStrip") {
          const θr = other.rotation * Math.PI / 180;
          const cosθ = Math.cos(θr), sinθ = Math.sin(θr);
          const relX = g.x - other.x, relY = g.y - other.y;
          const along = relX * cosθ + relY * sinθ;
          const perp = Math.abs(-relX * sinθ + relY * cosθ);
          if (along >= 0.4 && along <= other.size - 1.4 && perp < 0.5) {
            const sx = other.x + along * cosθ, sy = other.y + along * sinθ;
            const d = Math.hypot(g.x - sx, g.y - sy);
            if (d < bestDist) { bestDist = d; holePos = { x: sx, y: sy }; }
          }
        }
      }
    }
    setHoverHole(holePos);

    // Joint tool snapping: pivot/weld → part holes only (exact slot projection, no grid);
    // ground → grid only. Also applies when dragging an existing pivot/weld joint.
    const draggedJointKind = jointDrag ? st.joints.find(j => j.id === jointDrag.id)?.kind : null;
    const needsHoleSnap = st.tool === "pivot" || st.tool === "weld" ||
      (jointDrag && draggedJointKind !== "ground");
    if (needsHoleSnap) {
      let bestDist = 0.9, nearest = null;
      for (const part of st.parts) {
        for (const th of worldHoles(part)) {
          const d = Math.hypot(g.x - th.x, g.y - th.y);
          if (d < bestDist) { bestDist = d; nearest = { x: th.x, y: th.y }; }
        }
        if (part.type === "slottedStrip") {
          const θr = part.rotation * Math.PI / 180;
          const cosθ = Math.cos(θr), sinθ = Math.sin(θr);
          const relX = g.x - part.x, relY = g.y - part.y;
          const along = relX * cosθ + relY * sinθ;
          const perp = Math.abs(-relX * sinθ + relY * cosθ);
          if (along >= 0.5 && along <= part.size - 1.5 && perp < 0.7) {
            const sx = part.x + along * cosθ;
            const sy = part.y + along * sinθ;
            const d = Math.hypot(g.x - sx, g.y - sy);
            if (d < bestDist) { bestDist = d; nearest = { x: sx, y: sy }; }
          }
        }
      }
      setJointSnap(nearest);
    } else {
      setJointSnap(null);
    }

    // Pivot hole hover tracking for selected strip
    const selPart = st.parts.find(p => p.id === st.selectedId);
    if (selPart && st.tool === "select" && (selPart.type === "strip" || selPart.type === "slottedStrip")) {
      const opts = getPivotHoleOptions(selPart);
      let nearestPivot = null, bestPivotDist = 0.8;
      for (const hIdx of opts) {
        const wh = worldHoles(selPart)[hIdx];
        if (wh) {
          const d = Math.hypot(g.x - wh.x, g.y - wh.y);
          if (d < bestPivotDist) { bestPivotDist = d; nearestPivot = hIdx; }
        }
      }
      setHoverPivotHole(nearestPivot !== null ? { partId: selPart.id, holeIdx: nearestPivot } : null);
    } else {
      setHoverPivotHole(null);
    }

    if (selRect) {
      setSelRect(r => ({ ...r, x2: g.x, y2: g.y }));
      return;
    }

    // Joint drag
    if (jointDrag) {
      const draggedJoint = st.joints.find(j => j.id === jointDrag.id);
      const newPos = draggedJoint?.kind === "ground"
        ? snapToBoard(g.x, g.y)
        : (jointSnap ?? { x: g.x, y: g.y }); // pivot/weld: free cursor, snaps only to part holes
      dispatch({ type: "MOVE_JOINT_LIVE", id: jointDrag.id, x: newPos.x, y: newPos.y });
      return;
    }

    if (!drag) return;

    if (drag.kind === "multi-move") {
      const updates = {};
      for (const id of drag.ids) {
        const off = drag.offsets[id];
        if (off) updates[id] = { x: g.x + off.dx, y: g.y + off.dy };
      }
      dispatch({ type: "BATCH_UPDATE_PARTS_LIVE", updates });
      return;
    }

    if (drag.kind === "move") {
      const offX = drag.origPart.x - drag.startX;
      const offY = drag.origPart.y - drag.startY;
      const rawX = g.x + offX;
      const rawY = g.y + offY;

      // Try snapping a hole on the dragged part to any hole on another part
      const draggedPart = st.parts.find(p => p.id === drag.id);
      const rotation = draggedPart?.rotation ?? 0;
      let snappedToPartHole = null;
      let newSnapHint = null;
      if (draggedPart) {
        const localHoles = getLocalHoles(draggedPart);
        let bestDist = 0.9; // snap radius in grid units
        let weldTarget = null;
        for (const other of st.parts) {
          if (other.id === drag.id) continue;
          const otherHoles = worldHoles(other);
          for (let hi = 0; hi < otherHoles.length; hi++) {
            const th = otherHoles[hi];
            for (const lh of localHoles) {
              const rot = rotate(lh, rotation);
              const d = Math.hypot((rawX + rot.x) - th.x, (rawY + rot.y) - th.y);
              if (d < bestDist) {
                bestDist = d;
                snappedToPartHole = { x: th.x - rot.x, y: th.y - rot.y };
                newSnapHint = { x: th.x, y: th.y };
                if (draggedPart.type === "stamp") weldTarget = { partId: other.id, holeIdx: hi };
              }
            }
          }
        }
        if (draggedPart.type === "stamp") stampWeldRef.current = weldTarget;
      }
      setSnapHint(newSnapHint);

      const isFreePos = draggedPart?.type === "bell" || draggedPart?.type === "stamp";
      const pos = snappedToPartHole ?? (isFreePos ? { x: rawX, y: rawY } : snapToBoard(rawX, rawY));
      dispatch({ type: "UPDATE_PART_LIVE", id: drag.id, updates: { x: pos.x, y: pos.y } });
    } else if (drag.kind === "rotate") {
      const p = st.parts.find(pp => pp.id === drag.id);
      if (!p) return;
      const snap = (deg) => e.shiftKey ? deg : Math.round(deg / ANGLE_SNAP) * ANGLE_SNAP;
      if (drag.pivot?.localHole) {
        const { x: jx, y: jy, localHole } = drag.pivot;
        const rawDeg = Math.atan2(g.y - jy, g.x - jx) * 180 / Math.PI - (drag.handleAngle ?? 0) * 180 / Math.PI;
        const snappedDeg = snap(rawDeg);
        const r = rotate(localHole, snappedDeg);
        dispatch({ type: "UPDATE_PART_LIVE", id: drag.id, updates: { rotation: snappedDeg, x: jx - r.x, y: jy - r.y } });
      } else {
        const rawDeg = Math.atan2(g.y - p.y, g.x - p.x) * 180 / Math.PI;
        dispatch({ type: "UPDATE_PART_LIVE", id: drag.id, updates: { rotation: snap(rawDeg) } });
      }
    }
  };

  const handleSvgUp = (e) => {
    if (jointDrag) {
      const g = e ? pointerToGrid(e) : null;
      const draggedJoint = st.joints.find(j => j.id === jointDrag.id);
      const pos = draggedJoint?.kind === "ground"
        ? (g ? snapToBoard(g.x, g.y) : { x: jointDrag.origX, y: jointDrag.origY })
        : (jointSnap ?? { x: jointDrag.origX, y: jointDrag.origY }); // pivot/weld: revert to origin if not on a part hole
      const partsHere = st.parts.filter(p => {
        if (worldHoles(p).some(h => Math.hypot(h.x - pos.x, h.y - pos.y) < 0.6)) return true;
        if (p.type === "slottedStrip") {
          const θr = p.rotation * Math.PI / 180;
          const cosθ = Math.cos(θr), sinθ = Math.sin(θr);
          const relX = pos.x - p.x, relY = pos.y - p.y;
          const along = relX * cosθ + relY * sinθ;
          const perp = Math.abs(-relX * sinθ + relY * cosθ);
          if (along >= 0.4 && along <= p.size - 1.4 && perp < 0.6) return true;
        }
        return false;
      });
      dispatch({ type: "COMMIT_JOINT_MOVE", id: jointDrag.id, x: pos.x, y: pos.y, partIds: partsHere.map(p => p.id) });
      setJointDrag(null);
      return;
    }
    if (selRect) {
      const minX = Math.min(selRect.x1, selRect.x2), maxX = Math.max(selRect.x1, selRect.x2);
      const minY = Math.min(selRect.y1, selRect.y2), maxY = Math.max(selRect.y1, selRect.y2);
      if (Math.abs(maxX - minX) > 0.3 || Math.abs(maxY - minY) > 0.3) {
        const ids = new Set(st.parts.filter(p =>
          worldHoles(p).some(h => h.x >= minX && h.x <= maxX && h.y >= minY && h.y <= maxY)
        ).map(p => p.id));
        setMultiSelectedIds(ids);
        if (ids.size === 1) dispatch({ type: "SELECT", id: [...ids][0] });
      }
      setSelRect(null);
      return;
    }
    if (drag?.kind === "space-pan") { setDrag(null); return; }
    // Apply stamp weld on drop
    if (drag?.kind === "move" && drag.origPart?.type === "stamp") {
      const wt = stampWeldRef.current;
      let weldData = wt ?? null;
      if (wt) {
        const stamp = st.parts.find(p => p.id === drag.id);
        const host = st.parts.find(p => p.id === wt.partId);
        const rotationOffset = (stamp?.rotation || 0) - (host?.rotation || 0);
        weldData = { ...wt, rotationOffset };
      }
      dispatch({ type: "UPDATE_PART", id: drag.id, updates: { weldedTo: weldData } });
      stampWeldRef.current = null;
    }
    setDrag(null);
    setSnapHint(null);
  };

  // ---- Click on board (place new part if palette active) ----
  const handleSvgDown = (e) => {
    if (st.mode !== "build") return;

    // Spacebar or hand tool: start panning
    if (spaceHeldRef.current) {
      setDrag({ kind: "space-pan", startX: e.clientX, startY: e.clientY, startCamera: { ...cameraRef.current } });
      return;
    }
    if (st.tool === "hand") {
      setDrag({ kind: "pan", startX: e.clientX, startY: e.clientY, startCamera: { ...cameraRef.current } });
      return;
    }

    if (st.tool === "place" && st.palette) {
      const g = pointerToGrid(e); if (!g) return;
      const def = PALETTE.find(p => p.id === st.palette);
      if (!def) return;

      // Elastic two-click placement for strip and slottedStrip
      if (def.type === "strip" || def.type === "slottedStrip") {
        const origin = hoverHole ?? snapToBoard(g.x, g.y);
        if (!elastic) {
          setElastic({ origin, current: origin });
          return;
        }
        // Second click: commit
        const dx = elastic.current.x - elastic.origin.x;
        const dy = elastic.current.y - elastic.origin.y;
        const dist = Math.hypot(dx, dy);
        if (dist < 0.5) { setElastic(null); return; }
        const size = Math.max(2, Math.min(15, Math.round(dist) + 1));
        const rotation = Math.round(Math.atan2(dy, dx) * 180 / Math.PI / ANGLE_SNAP) * ANGLE_SNAP;
        dispatch({ type: "ADD_PART", part: { type: def.type, size, x: elastic.origin.x, y: elastic.origin.y, rotation } });
        setElastic(null);
        return;
      }

      const freePlace = def.type === "bell" || def.type === "stamp";
      let pos = freePlace ? { x: g.x, y: g.y } : (hoverHole ?? snapToBoard(g.x, g.y));

      // Centroid alignment for shapes: offset so centroid lands on the snapped grid point
      if (def.type === "triangle" || def.type === "square" || def.type === "pentagon") {
        const lh = getLocalHoles({ type: def.type });
        const c = lh[lh.length - 1]; // last hole = centroid
        pos = { x: pos.x - c.x, y: pos.y - c.y };
      }

      dispatch({
        type: "ADD_PART",
        part: { type: def.type, size: def.size, x: pos.x, y: pos.y, rotation: 0, ...(def.glyph ? { glyph: def.glyph } : {}) },
      });
      return;
    }
    if (["pivot", "weld", "ground"].includes(st.tool)) {
      const g = pointerToGrid(e); if (!g) return;
      const pos = st.tool === "ground" ? snapToBoard(g.x, g.y) : jointSnap;
      if (!pos) return; // pivot/weld must land on a part hole
      const partsHere = st.parts.filter(p => {
        if (worldHoles(p).some(h => Math.hypot(h.x - pos.x, h.y - pos.y) < 0.6)) return true;
        // For slotted strips, also match if pos is along the slot axis
        if (p.type === "slottedStrip") {
          const θr = p.rotation * Math.PI / 180;
          const cosθ = Math.cos(θr), sinθ = Math.sin(θr);
          const relX = pos.x - p.x, relY = pos.y - p.y;
          const along = relX * cosθ + relY * sinθ;
          const perp = Math.abs(-relX * sinθ + relY * cosθ);
          if (along >= 0.4 && along <= p.size - 1.4 && perp < 0.6) return true;
        }
        return false;
      });
      if (st.tool !== "ground" && partsHere.length === 0) return;
      // Snap to exact hole center of first connected part
      let snappedPos = { ...pos };
      for (const p of partsHere) {
        for (const wh of worldHoles(p)) {
          if (Math.hypot(wh.x - pos.x, wh.y - pos.y) < 0.7) { snappedPos = wh; break; }
        }
        break;
      }
      dispatch({
        type: "ADD_JOINT",
        joint: { kind: st.tool, x: snappedPos.x, y: snappedPos.y, partIds: partsHere.map(p => p.id) },
      });
      return;
    }
    // Pivot hole selection for selected strip (select tool only)
    if (st.tool === "select" && st.selectedId) {
      const selPart2 = st.parts.find(p => p.id === st.selectedId);
      if (selPart2 && (selPart2.type === "strip" || selPart2.type === "slottedStrip")) {
        const g3 = pointerToGrid(e);
        if (g3) {
          for (const hIdx of getPivotHoleOptions(selPart2)) {
            const wh = worldHoles(selPart2)[hIdx];
            if (wh && Math.hypot(g3.x - wh.x, g3.y - wh.y) < 0.7) {
              dispatch({ type: "UPDATE_PART", id: selPart2.id, updates: { pivotHoleIdx: hIdx } });
              return;
            }
          }
        }
      }
    }

    // Click/drag on empty board: deselect or start rect selection
    if (e.target === svgRef.current || e.target.dataset?.bg === "1") {
      dispatch({ type: "SELECT", id: null });
      setSelectedJointId(null);
      setMultiSelectedIds(new Set());
      if (st.tool === "select") {
        const g2 = pointerToGrid(e);
        if (g2) setSelRect({ x1: g2.x, y1: g2.y, x2: g2.x, y2: g2.y });
      }
    }
  };

  // ---- Part interactions ----
  const handlePartDown = (e, part) => {
    if (st.mode !== "build") return;
    if (["pivot", "weld", "ground"].includes(st.tool)) return; // let event bubble to handleSvgDown
    e.stopPropagation();
    if (st.tool === "delete") {
      dispatch({ type: "DELETE_PART", id: part.id });
      return;
    }
    if (st.tool === "select") {
      setSelectedJointId(null);
      const g = pointerToGrid(e);
      if (e.altKey) {
        // Alt+drag: duplicate and drag the copy
        const newId = "p" + st.nextId;
        dispatch({ type: "DUPLICATE_PART", id: part.id });
        setDrag({
          kind: "move", id: newId,
          startX: g?.x ?? 0, startY: g?.y ?? 0,
          origPart: { ...part, id: newId, x: part.x + 1, y: part.y + 1 },
        });
        return;
      }
      // If part is in multi-selection, drag all together
      if (multiSelectedIds.has(part.id) && multiSelectedIds.size > 1) {
        dispatch({ type: "SNAPSHOT" });
        const offsets = {};
        for (const id of multiSelectedIds) {
          const pp = st.parts.find(q => q.id === id);
          if (pp) offsets[id] = { dx: pp.x - (g?.x ?? 0), dy: pp.y - (g?.y ?? 0) };
        }
        setDrag({ kind: "multi-move", ids: [...multiSelectedIds], offsets });
        return;
      }
      dispatch({ type: "SELECT", id: part.id });
      setMultiSelectedIds(new Set());
      dispatch({ type: "SNAPSHOT" });
      setDrag({
        kind: "move",
        id: part.id,
        startX: g?.x ?? 0, startY: g?.y ?? 0,
        origPart: { ...part },
      });
    }
  };

  const handleRotateHandleDown = (e, part) => {
    e.stopPropagation();
    dispatch({ type: "SELECT", id: part.id });
    dispatch({ type: "SNAPSHOT" });

    const pivotIdx = part.pivotHoleIdx ?? 0;
    const localHoles = getLocalHoles(part);
    const wh = worldHoles(part);
    let pivot = null;
    if (localHoles[pivotIdx] && wh[pivotIdx]) {
      pivot = { x: wh[pivotIdx].x, y: wh[pivotIdx].y, localHole: localHoles[pivotIdx] };
    } else {
      const joint = st.joints.find(j => j.partIds.includes(part.id));
      if (joint) {
        const holeIdx = wh.findIndex(h => Math.hypot(h.x - joint.x, h.y - joint.y) < 0.5);
        if (holeIdx >= 0) pivot = { x: wh[holeIdx].x, y: wh[holeIdx].y, localHole: localHoles[holeIdx] };
      }
    }

    // Angle of handle relative to pivot in local space — needed to correct atan2 when handle is at -x
    const handleLocal = rotationHandleLocal(part);
    const pivotLocal = localHoles[pivotIdx] ?? { x: 0, y: 0 };
    const handleAngle = Math.atan2(handleLocal.y - pivotLocal.y, handleLocal.x - pivotLocal.x);

    setDrag({ kind: "rotate", id: part.id, origPart: { ...part }, pivot, handleAngle });
  };


  const handleJointDown = (e, joint) => {
    if (st.mode !== "build") return;
    e.stopPropagation();
    if (st.tool === "delete") {
      dispatch({ type: "DELETE_JOINT", id: joint.id });
      if (selectedJointId === joint.id) setSelectedJointId(null);
      return;
    }
    if (st.tool === "select") {
      dispatch({ type: "SELECT", id: null });
      setSelectedJointId(joint.id);
      dispatch({ type: "SNAPSHOT" });
      setJointDrag({ id: joint.id, origX: joint.x, origY: joint.y });
    }
  };

  // ---- Keyboard ----
  useEffect(() => {
    const onKeyDown = (e) => {
      // Spacebar pan
      if (e.code === "Space" && !e.target.closest?.("input, textarea")) {
        e.preventDefault();
        spaceHeldRef.current = true;
        setSpaceHeld(true);
        return;
      }
      const metaOrCtrl = e.metaKey || e.ctrlKey;
      if (metaOrCtrl && e.key.toLowerCase() === "z") {
        e.preventDefault();
        if (e.shiftKey) dispatch({ type: "REDO" });
        else dispatch({ type: "UNDO" });
        return;
      }
      if (metaOrCtrl && e.key.toLowerCase() === "y") {
        e.preventDefault(); dispatch({ type: "REDO" }); return;
      }
      if (e.key === "Escape") {
        setElastic(null);
        setCtxMenu(null);
        dispatch({ type: "TOOL", tool: "select" });
        return;
      }
      if (e.key === "Delete" || e.key === "Backspace") {
        if (multiSelectedIdsRef.current.size > 0) {
          e.preventDefault();
          dispatch({ type: "DELETE_PARTS", ids: [...multiSelectedIdsRef.current] });
          setMultiSelectedIds(new Set());
          return;
        }
        if (st.selectedId) {
          e.preventDefault();
          dispatch({ type: "DELETE_PART", id: st.selectedId });
          return;
        }
        if (selectedJointId) {
          e.preventDefault();
          dispatch({ type: "DELETE_JOINT", id: selectedJointId });
          setSelectedJointId(null);
          return;
        }
      }
      if (e.key.toLowerCase() === "r" && st.selectedId) {
        const p = st.parts.find(pp => pp.id === st.selectedId);
        if (p) {
          const delta = e.shiftKey ? -ANGLE_SNAP : ANGLE_SNAP;
          dispatch({ type: "UPDATE_PART", id: p.id, updates: { rotation: p.rotation + delta } });
        }
        return;
      }
      if (e.key.toLowerCase() === "m") {
        dispatch({ type: "TOOL", tool: "select" }); return;
      }
    };
    const onKeyUp = (e) => {
      if (e.code === "Space") {
        spaceHeldRef.current = false;
        setSpaceHeld(false);
        setDrag(d => d?.kind === "space-pan" ? null : d);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
    };
  }, [st.selectedId, st.parts, selectedJointId]);

  // Auto-show context menu only for multi-select (not single select — use right-click for that)
  useEffect(() => {
    if (st.mode !== "build" || multiSelectedIds.size < 2) {
      if (multiSelectedIds.size < 2) setCtxMenu(null);
      return;
    }

    const part = st.parts.find(p => multiSelectedIds.has(p.id));
    if (!part) { setCtxMenu(null); return; }

    const svg = svgRef.current;
    if (!svg) return;
    const rect = svg.getBoundingClientRect();
    const z = zoomRef.current;
    const cam = cameraRef.current;
    const sx = part.x * GRID * z - cam.x + rect.left;
    const sy = part.y * GRID * z - cam.y + rect.top;

    setCtxMenu({ x: sx, y: Math.max(100, sy - 60), part, multiIds: [...multiSelectedIds] });
  }, [multiSelectedIds, st.mode]); // eslint-disable-line

  useEffect(() => {
    if (!jointCtxMenu) return;
    const close = () => setJointCtxMenu(null);
    window.addEventListener("pointerdown", close);
    return () => window.removeEventListener("pointerdown", close);
  }, [jointCtxMenu]);

  // ---- Derived: board-hole index of parts ----
  const partHolesByGrid = useMemo(() => {
    // Map grid "i,j" → array of parts occupying that hole (integer snapped)
    const m = new Map();
    for (const p of st.parts) {
      const wh = worldHoles(p);
      for (const h of wh) {
        const i = Math.round(h.x), j = Math.round(h.y);
        // Only index if it's close to a grid hole
        if (Math.abs(h.x - i) < 0.2 && Math.abs(h.y - j) < 0.2 &&
            i >= 0 && i <= COLS - 1 && j >= 0 && j <= ROWS - 1) {
          const key = `${i},${j}`;
          if (!m.has(key)) m.set(key, []);
          m.get(key).push(p);
        }
      }
    }
    return m;
  }, [st.parts]);

  // ---- Rendering ----
  const ghostPart = useMemo(() => {
    if (st.tool !== "place" || !st.palette) return null;
    const def = PALETTE.find(p => p.id === st.palette);
    if (!def) return null;

    // Elastic strip: show live ghost from origin to cursor
    if (elastic && (def.type === "strip" || def.type === "slottedStrip")) {
      const dx = elastic.current.x - elastic.origin.x;
      const dy = elastic.current.y - elastic.origin.y;
      const dist = Math.hypot(dx, dy);
      if (dist < 0.5) return { type: def.type, size: 3, x: elastic.origin.x, y: elastic.origin.y, rotation: 0 };
      const size = Math.max(2, Math.min(15, Math.round(dist) + 1));
      const rotation = Math.round(Math.atan2(dy, dx) * 180 / Math.PI / ANGLE_SNAP) * ANGLE_SNAP;
      return { type: def.type, size, x: elastic.origin.x, y: elastic.origin.y, rotation };
    }

    if (!hoverHole) return null;

    // Pre-click strip ghost: show default-size 3 strip at cursor
    if (def.type === "strip" || def.type === "slottedStrip") {
      return { type: def.type, size: 3, x: hoverHole.x, y: hoverHole.y, rotation: 0 };
    }

    // Shapes: offset so centroid lands on hover point
    if (def.type === "triangle" || def.type === "square" || def.type === "pentagon") {
      const lh = getLocalHoles({ type: def.type });
      const c = lh[lh.length - 1];
      return { type: def.type, x: hoverHole.x - c.x, y: hoverHole.y - c.y, rotation: 0 };
    }

    return { type: def.type, size: def.size, x: hoverHole.x, y: hoverHole.y, rotation: 0 };
  }, [st.tool, st.palette, hoverHole, elastic]);

  const selectedPart = st.parts.find(p => p.id === st.selectedId);
  const displayParts = simParts ?? st.parts;
  const displayPartMap = useMemo(() => new Map(displayParts.map(p => [p.id, p])), [displayParts]);

  const jointToolActive = ["pivot", "weld", "ground"].includes(st.tool);

  return (
    <div
      className="w-full h-screen flex flex-col"
      style={{
        background: COLORS.shell,
        color: COLORS.ink,
        fontFamily: "'DM Sans', ui-sans-serif, system-ui, sans-serif",
      }}
    >
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=DM+Serif+Display&family=DM+Sans:wght@400;500;600;700&family=DM+Mono:wght@400;500&family=Noto+Symbols+2&display=swap');
        .serif { font-family: 'DM Serif Display', ui-serif, Georgia, serif; }
        .mono { font-family: 'DM Mono', ui-monospace, monospace; }
        .tool-btn { transition: background 120ms ease, transform 120ms ease, border-color 120ms ease; }
        .tool-btn:hover { transform: translateY(-1px); }
        .tool-btn:active { transform: translateY(0); }
        .noise {
          background-image: radial-gradient(rgba(255,255,255,0.02) 1px, transparent 1px);
          background-size: 3px 3px;
        }
      `}</style>

      <TopBar st={st} dispatch={dispatch} simPaused={simPaused} setSimPaused={setSimPaused} />

      <div className="flex-1 relative min-h-0" style={{ background: COLORS.board, overflow: "hidden" }}>
          <svg
            ref={svgRef}
            style={{
              display: "block", width: "100%", height: "100%",
              cursor:
                spaceHeld ? (drag?.kind === "space-pan" ? "grabbing" : "grab") :
                st.tool === "hand" ? (drag?.kind === "pan" ? "grabbing" : "grab") :
                st.tool === "place" ? "crosshair" :
                st.tool === "delete" ? "not-allowed" :
                jointToolActive ? "crosshair" :
                drag?.kind === "move" || drag?.kind === "multi-move" ? "move" :
                drag?.kind === "rotate" ? "grabbing" : "default",
            }}
            onPointerDown={handleSvgDown}
            onPointerMove={handleSvgMove}
            onPointerUp={(e) => handleSvgUp(e)}
            onPointerLeave={(e) => handleSvgUp(e)}
            onContextMenu={(e) => e.preventDefault()}
          >
            <defs>
              <pattern id="board-dots" x={-GRID / 2} y={-GRID / 2} width={GRID} height={GRID} patternUnits="userSpaceOnUse">
                <circle cx={GRID / 2} cy={GRID / 2} r={HOLE_R_BOARD} fill={COLORS.boardDot} opacity="0.8" />
              </pattern>
            </defs>
            {/* Camera transform: everything in world coords */}
            <g transform={`translate(${-camera.x}, ${-camera.y}) scale(${zoom})`}>
            {/* Board background + dots via pattern */}
            <rect data-bg="1" x={-BOARD_PAD * GRID} y={-BOARD_PAD * GRID} width={boardW} height={boardH} rx="8" ry="8" fill={COLORS.board} />
            <rect x="0" y="0" width={(COLS - 1) * GRID} height={(ROWS - 1) * GRID} fill="url(#board-dots)" pointerEvents="none" />

            {/* Hover hole indicator */}
            {hoverHole && st.mode === "build" && (
              <circle
                cx={hoverHole.x * GRID} cy={hoverHole.y * GRID}
                r={7}
                fill="none"
                stroke={
                  st.tool === "pivot" ? COLORS.pivot :
                  st.tool === "weld" ? COLORS.weld :
                  st.tool === "ground" ? COLORS.ground :
                  "rgba(255,255,255,0.35)"
                }
                strokeWidth="1.8"
                pointerEvents="none"
              />
            )}

            {/* Snap-to-hole indicator */}
            {snapHint && st.mode === "build" && (
              <g pointerEvents="none">
                <circle cx={snapHint.x * GRID} cy={snapHint.y * GRID} r={11}
                  fill="none" stroke={COLORS.select} strokeWidth="2" opacity="0.9" />
                <circle cx={snapHint.x * GRID} cy={snapHint.y * GRID} r={4}
                  fill={COLORS.select} opacity="0.7" />
              </g>
            )}

            {/* Parts */}
            <g>
              {[...displayParts].sort((a, b) => {
                const za = (a.zIndex ?? 0) + (a.type === "motor" ? -1000 : 0);
                const zb = (b.zIndex ?? 0) + (b.type === "motor" ? -1000 : 0);
                return za - zb;
              }).map(p => (
                <g
                  key={p.id}
                  style={{ cursor: st.mode === "play" ? "default" : st.tool === "select" ? "move" : (st.tool === "delete" ? "not-allowed" : "default") }}
                  onPointerDown={(e) => handlePartDown(e, p)}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    if (st.mode !== "build") return;
                    e.stopPropagation();
                    const isMulti = multiSelectedIds.size > 1 && multiSelectedIds.has(p.id);
                    setCtxMenu({ x: e.clientX, y: e.clientY, part: p, multiIds: isMulti ? [...multiSelectedIds] : null });
                  }}
                >
                  <PartShape part={p} selected={p.id === st.selectedId && st.mode === "build"} />
                </g>
              ))}
            </g>

            {/* Joint snap indicator */}
            {jointToolActive && jointSnap && (
              <g pointerEvents="none">
                <circle
                  cx={jointSnap.x * GRID} cy={jointSnap.y * GRID} r={10}
                  fill="none"
                  stroke={st.tool === "pivot" ? COLORS.pivot : st.tool === "weld" ? COLORS.weld : COLORS.ground}
                  strokeWidth="2.5" opacity="0.9"
                />
                <circle
                  cx={jointSnap.x * GRID} cy={jointSnap.y * GRID} r={3.5}
                  fill={st.tool === "pivot" ? COLORS.pivot : st.tool === "weld" ? COLORS.weld : COLORS.ground}
                  opacity="0.7"
                />
              </g>
            )}

            {/* Rotation handle for selected part */}
            {selectedPart && st.mode === "build" && (
              <RotationHandle
                part={selectedPart}
                onPointerDown={(e) => handleRotateHandleDown(e, selectedPart)}
                hovered={hoverRotHandle}
                onHoverChange={(v) => setHoverRotHandle(v)}
                onSwitchPivot={() => {
                  const pivotIdx = selectedPart.pivotHoleIdx ?? 0;
                  const otherIdx = pivotIdx === 0 ? selectedPart.size - 1 : 0;
                  dispatch({ type: "UPDATE_PART", id: selectedPart.id, updates: { pivotHoleIdx: otherIdx } });
                }}
              />
            )}

            {/* Pivot hole options for selected strip */}
            {selectedPart && st.mode === "build" && st.tool === "select" &&
              (selectedPart.type === "strip" || selectedPart.type === "slottedStrip") && (
              <g pointerEvents="all">
                {getPivotHoleOptions(selectedPart).map(hIdx => {
                  const wh = worldHoles(selectedPart)[hIdx];
                  if (!wh) return null;
                  const isActive = (selectedPart.pivotHoleIdx ?? 0) === hIdx;
                  const isHov = hoverPivotHole?.partId === selectedPart.id && hoverPivotHole?.holeIdx === hIdx;
                  return (
                    <circle
                      key={hIdx}
                      cx={wh.x * GRID} cy={wh.y * GRID}
                      r={isActive ? 7 : isHov ? 6 : 5}
                      fill={isActive ? COLORS.select : isHov ? COLORS.select + "99" : "rgba(255,210,63,0.25)"}
                      stroke={COLORS.select}
                      strokeWidth="1.5"
                      style={{ cursor: "pointer" }}
                      onPointerDown={(e) => {
                        e.stopPropagation();
                        dispatch({ type: "UPDATE_PART", id: selectedPart.id, updates: { pivotHoleIdx: hIdx } });
                      }}
                    />
                  );
                })}
              </g>
            )}

            {/* Multi-select halos */}
            {multiSelectedIds.size > 1 && [...multiSelectedIds].map(id => {
              const p = st.parts.find(pp => pp.id === id);
              if (!p) return null;
              return (
                <g key={id} transform={`translate(${p.x * GRID},${p.y * GRID}) rotate(${p.rotation})`} pointerEvents="none">
                  <SelectionHalo part={p} />
                </g>
              );
            })}

            {/* Rectangle selection box */}
            {selRect && (
              <rect
                x={Math.min(selRect.x1, selRect.x2) * GRID}
                y={Math.min(selRect.y1, selRect.y2) * GRID}
                width={Math.abs(selRect.x2 - selRect.x1) * GRID}
                height={Math.abs(selRect.y2 - selRect.y1) * GRID}
                fill="rgba(255,210,63,0.07)"
                stroke={COLORS.select}
                strokeWidth="1.4"
                strokeDasharray="5 3"
                pointerEvents="none"
              />
            )}

            {/* Ghost preview for placement */}
            {ghostPart && (
              <g pointerEvents="none">
                <PartShape part={ghostPart} ghost />
              </g>
            )}

            {/* Joints — rendered last so they are always on top */}
            <g>
              {st.joints.map(j => {
                let jx = j.x, jy = j.y;
                if (simParts && simRef.current?.constraintMap) {
                  const cm = simRef.current.constraintMap.get(j.id);
                  const entry = cm?.[0];
                  if (entry) {
                    const sp = displayPartMap.get(entry.partId);
                    if (sp) {
                      const wh = simWorldHole(sp, entry.holeIdx);
                      jx = wh.x; jy = wh.y;
                    }
                  }
                } else {
                  // Build mode: render at closest hole of first connected part for alignment
                  let bestD = 2;
                  for (const pid of j.partIds) {
                    const pp = st.parts.find(p => p.id === pid);
                    if (!pp) continue;
                    for (const wh of worldHoles(pp)) {
                      const d = Math.hypot(wh.x - j.x, wh.y - j.y);
                      if (d < bestD) { bestD = d; jx = wh.x; jy = wh.y; }
                    }
                    break;
                  }
                }
                return (
                  <JointPin
                    key={j.id}
                    joint={j}
                    overrideX={jx}
                    overrideY={jy}
                    onPointerDown={(e) => handleJointDown(e, j)}
                    deletable={st.tool === "delete" && st.mode === "build"}
                    selected={j.id === selectedJointId && st.mode === "build"}
                    onContextMenu={(e) => {
                      if (st.mode !== "build") return;
                      e.preventDefault();
                      e.stopPropagation();
                      setJointCtxMenu({ x: e.clientX, y: e.clientY, joint: j });
                    }}
                  />
                );
              })}
            </g>

            {/* Elastic placement origin dot */}
            {elastic && (
              <circle
                cx={elastic.origin.x * GRID} cy={elastic.origin.y * GRID}
                r={6} fill={COLORS.select} stroke={COLORS.partEdge} strokeWidth="1.5"
                pointerEvents="none"
              />
            )}
            </g>{/* end camera transform */}
          </svg>

          {/* Empty state hint */}
          {st.parts.length === 0 && !st.palette && (
            <div
              className="absolute pointer-events-none text-center px-6"
              style={{ color: COLORS.inkDim, maxWidth: 460 }}
            >
              <div className="serif text-3xl mb-2" style={{ color: COLORS.ink }}>
                Pick a piece
              </div>
              <div className="mono text-sm opacity-80">
                Choose a strip or shape from the left palette, then click a hole to place it.
              </div>
            </div>
          )}

          {/* Bottom-left status */}
          <StatusChip st={st} hoverHole={hoverHole} simJammed={simJammed} />

          {/* Zoom controls — bottom-right */}
          <div
            className="absolute bottom-4 right-4 flex flex-col gap-1 pointer-events-auto z-20"
          >
            <button
              className="w-8 h-8 rounded mono text-sm flex items-center justify-center tool-btn"
              style={{ background: COLORS.sidebar, border: `1px solid ${COLORS.divider}`, color: COLORS.ink }}
              onClick={() => handleZoom(0.15)}
              title="Zoom in (+)"
            >+</button>
            <div className="mono text-[9px] text-center" style={{ color: COLORS.inkDim }}>{Math.round(zoom * 100)}%</div>
            <button
              className="w-8 h-8 rounded mono text-sm flex items-center justify-center tool-btn"
              style={{ background: COLORS.sidebar, border: `1px solid ${COLORS.divider}`, color: COLORS.ink }}
              onClick={() => handleZoom(-0.15)}
              title="Zoom out (-)"
            >−</button>
          </div>

          {/* Right-click context menu */}
          {ctxMenu && (() => {
            const livePart = st.parts.find(p => p.id === ctxMenu.part.id) ?? ctxMenu.part;
            return (
              <ContextMenu
                x={ctxMenu.x} y={ctxMenu.y} part={livePart} multiIds={ctxMenu.multiIds}
                onClose={() => setCtxMenu(null)}
                onAction={(type, updates, live) => {
                  if (type === "DELETE_PARTS") {
                    dispatch({ type: "DELETE_PARTS", ids: ctxMenu.multiIds });
                    setMultiSelectedIds(new Set());
                  } else if (type === "DELETE_PART") {
                    dispatch({ type, id: ctxMenu.part.id });
                  } else if (type === "BRING_FORWARD") dispatch({ type, id: ctxMenu.part.id });
                  else if (type === "SEND_BACKWARD") dispatch({ type, id: ctxMenu.part.id });
                  else dispatch({ type: live ? "UPDATE_PART_LIVE" : "UPDATE_PART", id: ctxMenu.part.id, updates });
                  if (!live) setCtxMenu(null);
                }}
              />
            );
          })()}

          {/* Joint right-click menu */}
          {jointCtxMenu && (
            <JointContextMenu
              x={jointCtxMenu.x} y={jointCtxMenu.y} joint={jointCtxMenu.joint}
              onClose={() => setJointCtxMenu(null)}
              onAction={(type, payload) => {
                if (type === "DELETE_JOINT") dispatch({ type, id: jointCtxMenu.joint.id });
                else if (type === "CONVERT_JOINT") dispatch({ type, id: jointCtxMenu.joint.id, kind: payload.kind });
                setJointCtxMenu(null);
              }}
            />
          )}

        {/* Floating left toolbar */}
        <FloatingToolbar st={st} dispatch={dispatch} />

        {/* Floating instruments toolbar */}
        <FloatingInstruments st={st} dispatch={dispatch} />
      </div>
    </div>
  );
}

// ---------- Context menu ----------
function ContextMenu({ x, y, part, multiIds, onClose, onAction }) {
  const isStrip = part.type === "strip" || part.type === "slottedStrip";
  const isMotor = part.type === "motor";
  const curSpeed = part.speed ?? MOTOR_SPEED_DEG;
  const curDir = part.direction ?? 1;

  const isBell = part.type === "bell";
  const isMulti = multiIds && multiIds.length > 1;
  const items = [
    isMulti
      ? { label: `Delete ${multiIds.length} selected parts`, danger: true, action: () => onAction("DELETE_PARTS") }
      : { label: "Delete", danger: true, action: () => onAction("DELETE_PART") },
    !isMulti && { label: "Duplicate", action: () => onAction("DUPLICATE_PART") },
    !isMulti && !isMotor && !isBell && { label: "Bring Forward", action: () => onAction("BRING_FORWARD") },
    !isMulti && !isMotor && !isBell && (part.zIndex ?? 0) > 0 && { label: "Send Backward", action: () => onAction("SEND_BACKWARD") },
    !isMulti && isMotor && { separator: true },
    !isMulti && isMotor && { label: curDir === 1 ? "↺ Set Counter-clockwise" : "↻ Set Clockwise", action: () => onAction("UPDATE_PART", { direction: curDir === 1 ? -1 : 1 }) },
    !isMulti && isMotor && { separator: true },
    !isMulti && isMotor && { label: `Slow — 45°/s${curSpeed === 45 ? "  ✓" : ""}`,  action: () => onAction("UPDATE_PART", { speed: 45 }) },
    !isMulti && isMotor && { label: `Normal — 90°/s${curSpeed === 90 ? "  ✓" : ""}`, action: () => onAction("UPDATE_PART", { speed: 90 }) },
    !isMulti && isMotor && { label: `Fast — 180°/s${curSpeed === 180 ? "  ✓" : ""}`, action: () => onAction("UPDATE_PART", { speed: 180 }) },
    !isMulti && isMotor && { label: `Very Fast — 360°/s${curSpeed === 360 ? "  ✓" : ""}`, action: () => onAction("UPDATE_PART", { speed: 360 }) },
    !isMulti && isBell && { separator: true },
    ...Object.keys(NOTES).filter(() => !isMulti && isBell).map(note => ({
      label: `♪ ${note}${part.note === note ? "  ✓" : ""}`,
      action: () => onAction("UPDATE_PART", { note }),
    })),
  ].filter(Boolean);

  return (
    <div
      data-ctx-menu="1"
      className="absolute z-50 py-1 rounded shadow-lg"
      style={{
        left: x, top: y,
        background: COLORS.sidebar,
        border: `1px solid ${COLORS.divider}`,
        minWidth: 164,
        transform: "translate(-50%, -50%)",
      }}
      onPointerDown={(e) => e.stopPropagation()}
    >
      {/* Strip size slider */}
      {!isMulti && isStrip && (
        <div className="px-3 py-2 border-b" style={{ borderColor: COLORS.divider }}>
          <div className="mono text-[10px] mb-1.5" style={{ color: COLORS.inkDim }}>
            Size: {part.size} holes
          </div>
          <input
            type="range" min={2} max={15} value={part.size}
            onChange={(e) => onAction("UPDATE_PART", { size: parseInt(e.target.value) }, true)}
            style={{ width: "100%", accentColor: COLORS.board }}
          />
          <div className="flex justify-between mono text-[9px]" style={{ color: COLORS.inkDim }}>
            <span>2</span><span>15</span>
          </div>
        </div>
      )}
      {items.map((item, i) =>
        item.separator
          ? <div key={i} style={{ height: 1, background: COLORS.divider, margin: "3px 0" }} />
          : (
          <button
            key={i}
            onClick={item.action}
            className="w-full text-left px-3 py-1.5 mono text-xs tool-btn"
            style={{ color: item.danger ? COLORS.weld : COLORS.ink, background: "transparent", display: "block" }}
            onMouseEnter={(e) => e.currentTarget.style.background = COLORS.shellDeep}
            onMouseLeave={(e) => e.currentTarget.style.background = "transparent"}
          >
            {item.label}
          </button>
        )
      )}
    </div>
  );
}

// ---------- Joint context menu ----------
function JointContextMenu({ x, y, joint, onClose, onAction }) {
  const otherKinds = ["pivot", "weld", "ground"].filter(k => k !== joint.kind);
  const items = [
    { label: "Delete joint", danger: true, action: () => onAction("DELETE_JOINT") },
    ...otherKinds.map(k => ({
      label: `Convert to ${k}`,
      action: () => onAction("CONVERT_JOINT", { kind: k }),
    })),
  ];
  return (
    <div
      className="absolute z-50 py-1 rounded shadow-lg"
      style={{
        left: x, top: y,
        background: COLORS.sidebar,
        border: `1px solid ${COLORS.divider}`,
        minWidth: 160,
        transform: "translate(4px, 4px)",
      }}
      onPointerDown={(e) => e.stopPropagation()}
    >
      {items.map((item, i) => (
        <button
          key={i}
          onClick={item.action}
          className="w-full text-left px-3 py-1.5 mono text-xs tool-btn"
          style={{ color: item.danger ? COLORS.weld : COLORS.ink, background: "transparent", display: "block" }}
          onMouseEnter={(e) => e.currentTarget.style.background = COLORS.shellDeep}
          onMouseLeave={(e) => e.currentTarget.style.background = "transparent"}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}

// ---------- Joint pin ----------
function JointPin({ joint, onPointerDown, deletable, overrideX, overrideY, selected, onContextMenu }) {
  const cx = (overrideX !== undefined ? overrideX : joint.x) * GRID;
  const cy = (overrideY !== undefined ? overrideY : joint.y) * GRID;
  const color =
    joint.kind === "pivot" ? COLORS.pivot :
    joint.kind === "weld" ? COLORS.weld :
    COLORS.ground;
  return (
    <g style={{ cursor: deletable ? "not-allowed" : "pointer" }} onPointerDown={onPointerDown} onContextMenu={onContextMenu}>
      {selected && (
        <circle cx={cx} cy={cy} r={JOINT_R + 6}
          fill="none" stroke={COLORS.select} strokeWidth="2" strokeDasharray="4 3" opacity="0.9" />
      )}
      {joint.kind === "weld" ? (
        <>
          <rect x={cx - JOINT_R} y={cy - JOINT_R} width={JOINT_R * 2} height={JOINT_R * 2}
                rx="2" fill={color} stroke={COLORS.partEdge} strokeWidth="1.4" />
          <path
            d={`M ${cx - 4} ${cy - 4} L ${cx + 4} ${cy + 4} M ${cx - 4} ${cy + 4} L ${cx + 4} ${cy - 4}`}
            stroke={COLORS.partEdge} strokeWidth="1.6" strokeLinecap="round"
          />
        </>
      ) : joint.kind === "ground" ? (
        <>
          <circle cx={cx} cy={cy} r={JOINT_R} fill={color} stroke={COLORS.partEdge} strokeWidth="1.4" />
          <path
            d={`M ${cx - 5} ${cy + 3} L ${cx + 5} ${cy + 3}
                M ${cx - 3.5} ${cy + 6} L ${cx + 3.5} ${cy + 6}
                M ${cx - 1.8} ${cy + 9} L ${cx + 1.8} ${cy + 9}`}
            stroke={COLORS.partEdge} strokeWidth="1.4" strokeLinecap="round"
          />
        </>
      ) : (
        <>
          <circle cx={cx} cy={cy} r={JOINT_R} fill={color} stroke={COLORS.partEdge} strokeWidth="1.4" />
          <circle cx={cx} cy={cy} r={2.2} fill={COLORS.partEdge} />
        </>
      )}
    </g>
  );
}

// ---------- Rotation handle ----------
function RotationHandle({ part, onPointerDown, hovered, onHoverChange, onSwitchPivot }) {
  const local = rotationHandleLocal(part);
  const rotated = rotate(local, part.rotation);
  const cx = (part.x + rotated.x) * GRID;
  const cy = (part.y + rotated.y) * GRID;
  const pivotIdx = part.pivotHoleIdx ?? 0;
  const wh = worldHoles(part);
  const pivotWH = wh[pivotIdx];
  const ax = pivotWH ? pivotWH.x * GRID : part.x * GRID;
  const ay = pivotWH ? pivotWH.y * GRID : part.y * GRID;

  const isStrip = part.type === "strip" || part.type === "slottedStrip";
  const otherIdx = isStrip ? (pivotIdx === 0 ? part.size - 1 : 0) : null;
  // Ghost handle = where handle would be with the other pivot selected
  const ghostLocal = isStrip && otherIdx !== null
    ? rotationHandleLocal({ ...part, pivotHoleIdx: otherIdx })
    : { x: -local.x, y: -local.y };
  const ghostRotated = rotate(ghostLocal, part.rotation);
  const gx = (part.x + ghostRotated.x) * GRID;
  const gy = (part.y + ghostRotated.y) * GRID;

  return (
    <g>
      <line x1={ax} y1={ay} x2={cx} y2={cy} stroke={COLORS.select} strokeWidth="1.5" strokeDasharray="3 3" opacity="0.8" />
      {/* Invisible trigger zone at the opposite end — hovering here reveals the ghost */}
      {isStrip && otherIdx !== null && (
        <g
          style={{ cursor: hovered ? "pointer" : "default" }}
          onPointerDown={hovered ? (e) => { e.stopPropagation(); onSwitchPivot?.(); } : undefined}
          onMouseEnter={() => onHoverChange?.(true)}
          onMouseLeave={() => onHoverChange?.(false)}
        >
          <circle cx={gx} cy={gy} r={50} fill="transparent" />
          {hovered && (
            <circle cx={gx} cy={gy} r={8} fill={COLORS.select} opacity="0.35" stroke={COLORS.select} strokeWidth="1.4" strokeDasharray="3 2" />
          )}
        </g>
      )}
      {/* Active handle — large invisible hit area + small visible dot */}
      <g style={{ cursor: "grab" }} onPointerDown={onPointerDown}>
        <circle cx={cx} cy={cy} r={22} fill="transparent" />
        <circle cx={cx} cy={cy} r={8} fill={COLORS.select} stroke={COLORS.partEdge} strokeWidth="1.4" />
      </g>
    </g>
  );
}

// ---------- Top bar ----------
function TopBar({ st, dispatch, simPaused, setSimPaused }) {
  return (
    <div
      className="flex items-center justify-between px-5 border-b"
      style={{ borderColor: COLORS.divider, background: COLORS.sidebar, height: 56 }}
    >
      <div className="flex items-center gap-3">
        <div
          className="w-7 h-7 rounded-sm flex items-center justify-center"
          style={{ background: COLORS.board }}
        >
          <Sparkles size={16} color={COLORS.shell} strokeWidth={2.4} />
        </div>
        <div className="flex flex-col leading-none">
          <div className="serif text-2xl" style={{ color: COLORS.ink }}>Zine Machine</div>
          <div className="mono text-[9px]" style={{ color: COLORS.inkDim, letterSpacing: "0.06em" }}>by Khushbu Kshirsagar</div>
        </div>
        <div className="mono text-[10px] px-2 py-1 rounded"
             style={{ background: COLORS.shell, color: st.mode === "play" ? COLORS.pivot : COLORS.inkDim, letterSpacing: "0.08em" }}>
          {st.mode === "play" ? "R2 · SIMULATION" : "R1 · CONSTRUCTION"}
        </div>
      </div>

      <div className="flex items-center gap-2">
        <div className="flex rounded-md overflow-hidden border" style={{ borderColor: COLORS.divider }}>
          <ModeBtn
            active={st.mode === "build"}
            onClick={() => dispatch({ type: "MODE", mode: "build" })}
            icon={<Hammer size={14} />}
            label="Build"
          />
          <ModeBtn
            active={st.mode === "play"}
            onClick={() => { setSimPaused(false); dispatch({ type: "MODE", mode: st.mode === "play" ? "build" : "play" }); }}
            icon={<Play size={14} />}
            label={st.mode === "play" ? "Stop" : "Play"}
          />
        </div>
        {st.mode === "play" && (
          <div className="flex rounded-md overflow-hidden border" style={{ borderColor: COLORS.divider }}>
            <ModeBtn
              active={simPaused}
              onClick={() => setSimPaused(p => !p)}
              icon={simPaused ? <Play size={14} /> : <Pause size={14} />}
              label={simPaused ? "Resume" : "Pause"}
            />
          </div>
        )}

        <div className="w-px h-6 mx-2" style={{ background: COLORS.divider }} />

        <IconBtn
          onClick={() => dispatch({ type: "UNDO" })}
          disabled={st.undo.length === 0}
          title="Undo (⌘Z)"
        ><Undo2 size={15} /></IconBtn>
        <IconBtn
          onClick={() => dispatch({ type: "REDO" })}
          disabled={st.redo.length === 0}
          title="Redo (⌘⇧Z)"
        ><Redo2 size={15} /></IconBtn>

        <div className="w-px h-6 mx-2" style={{ background: COLORS.divider }} />

        <button
          onClick={() => {
            const data = { parts: st.parts, joints: st.joints, nextId: st.nextId };
            const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url; a.download = 'zine-machine.json'; a.click();
            URL.revokeObjectURL(url);
          }}
          className="mono text-[11px] px-2 py-1.5 rounded tool-btn"
          style={{ background: "transparent", color: COLORS.inkDim, border: `1px solid ${COLORS.divider}` }}
          title="Save design as file"
        >SAVE</button>
        <button
          onClick={() => {
            const input = document.createElement('input');
            input.type = 'file'; input.accept = '.json';
            input.onchange = (ev) => {
              const file = ev.target.files?.[0]; if (!file) return;
              const reader = new FileReader();
              reader.onload = (re) => {
                try { dispatch({ type: "LOAD_STATE", data: JSON.parse(re.target.result) }); }
                catch(_) { alert("Invalid file."); }
              };
              reader.readAsText(file);
            };
            input.click();
          }}
          className="mono text-[11px] px-2 py-1.5 rounded tool-btn"
          style={{ background: "transparent", color: COLORS.inkDim, border: `1px solid ${COLORS.divider}` }}
          title="Load design from file"
        >LOAD</button>
        <button
          onClick={() => {
            if (confirm("Clear the whole board?")) dispatch({ type: "CLEAR" });
          }}
          className="mono text-[11px] px-2 py-1.5 rounded tool-btn"
          style={{
            background: "transparent", color: COLORS.inkDim,
            border: `1px solid ${COLORS.divider}`,
          }}
        >
          CLEAR
        </button>
      </div>
    </div>
  );
}

function ModeBtn({ active, onClick, icon, label, disabled, hint }) {
  return (
    <button
      disabled={disabled}
      onClick={onClick}
      className="mono text-[11px] px-3 py-1.5 flex items-center gap-1.5 tool-btn"
      style={{
        background: active ? COLORS.board : "transparent",
        color: active ? COLORS.shell : (disabled ? COLORS.inkDim : COLORS.ink),
        opacity: disabled ? 0.55 : 1,
        letterSpacing: "0.05em",
      }}
      title={hint}
    >
      {icon}
      {label.toUpperCase()}
      {hint && <span style={{ opacity: 0.55, marginLeft: 2 }}>· {hint}</span>}
    </button>
  );
}

function IconBtn({ children, onClick, disabled, title }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={title}
      className="w-8 h-8 rounded flex items-center justify-center tool-btn"
      style={{
        background: "transparent",
        color: disabled ? COLORS.inkDim : COLORS.ink,
        border: `1px solid ${COLORS.divider}`,
        opacity: disabled ? 0.4 : 1,
      }}
    >
      {children}
    </button>
  );
}

// ---------- Shape icon (inline SVG for the shapes group) ----------
function ShapeIcon({ size = 16 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16">
      <polygon points="8,2 14,14 2,14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
    </svg>
  );
}
function StripIcon({ size = 16 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16">
      <rect x="1" y="6" width="14" height="4" rx="2" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <circle cx="4" cy="8" r="1.2" fill="currentColor" />
      <circle cx="8" cy="8" r="1.2" fill="currentColor" />
      <circle cx="12" cy="8" r="1.2" fill="currentColor" />
    </svg>
  );
}
function SlotIcon({ size = 16 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16">
      <rect x="1" y="6" width="14" height="4" rx="2" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <rect x="3" y="7.5" width="10" height="1" rx="0.5" fill="currentColor" opacity="0.6" />
    </svg>
  );
}

// ---------- Floating left toolbar ----------
function FloatingToolbar({ st, dispatch }) {
  const [openGroup, setOpenGroup] = useState(null);

  // Close submenu after a part or joint is placed
  const prevPartsLen = useRef(st.parts.length);
  const prevJointsLen = useRef(st.joints.length);
  useEffect(() => {
    if (st.parts.length > prevPartsLen.current || st.joints.length > prevJointsLen.current) {
      setOpenGroup(null);
    }
    prevPartsLen.current = st.parts.length;
    prevJointsLen.current = st.joints.length;
  }, [st.parts.length, st.joints.length]);

  const isJointActive = ["pivot", "weld", "ground"].includes(st.tool);
const isShapeActive = PALETTE.filter(p => ["triangle","square","pentagon"].includes(p.type)).some(p => p.id === st.palette);

  const toolItems = [
    { id: "select", icon: <MousePointer2 size={15} />,  label: "Select",  active: st.tool === "select" && !openGroup, direct: true },
    { id: "hand",   icon: <Hand size={15} />,          label: "Pan",     active: st.tool === "hand"   && !openGroup, direct: true },
    null,
    { id: "joints", icon: <PivotIcon size={15} />,       label: "Joints",  active: isJointActive || openGroup === "joints", group: true },
    { id: "strip",  icon: <StripIcon size={15} />,    label: "Strip",   active: st.palette === "strip"  && !openGroup, palette: "strip" },
    { id: "slot",   icon: <SlotIcon size={15} />,     label: "Slotted", active: st.palette === "slot"   && !openGroup, palette: "slot" },
    { id: "shapes", icon: <ShapeIcon size={15} />,    label: "Shapes",  active: isShapeActive || openGroup === "shapes", group: true },
    { id: "motor",  icon: <CircleIcon size={15} />,   label: "Motor",   active: st.palette === "motor" && !openGroup, palette: "motor" },
  ];

  const GROUP_DEFAULTS = {
    joints: () => dispatch({ type: "TOOL", tool: "pivot" }),
    shapes: () => dispatch({ type: "PALETTE", id: "triangle" }),
  };

  const handleClick = (t) => {
    if (t.direct) { dispatch({ type: "TOOL", tool: t.id }); setOpenGroup(null); }
    else if (t.palette) { dispatch({ type: "PALETTE", id: t.palette }); setOpenGroup(null); }
    else if (t.group) {
      const wasOpen = openGroup === t.id;
      setOpenGroup(wasOpen ? null : t.id);
      if (!wasOpen) GROUP_DEFAULTS[t.id]?.();
    }
  };

  return (
    <div className="absolute left-4 top-4 z-20 flex gap-2 items-start pointer-events-none">
      {/* Icon strip */}
      <div
        className="flex flex-col gap-0.5 rounded-xl p-1.5 shadow-xl pointer-events-auto"
        style={{ background: COLORS.sidebar, border: `1px solid ${COLORS.divider}` }}
      >
        {toolItems.map((t, i) => t === null ? (
          <div key={i} style={{ height: 1, background: COLORS.divider, margin: "2px 0" }} />
        ) : (
          <button
            key={t.id}
            className="relative w-9 h-9 rounded-lg flex items-center justify-center tool-btn"
            style={{
              background: t.active ? `${COLORS.select}18` : "transparent",
              color: COLORS.ink,
              border: `1.5px solid ${t.active ? COLORS.select + "55" : "transparent"}`,
            }}
            title={t.label}
            onClick={() => handleClick(t)}
          >
            {t.icon}
            {t.group && (
              <span style={{ position: "absolute", right: 2, bottom: 2, opacity: 0.5, fontSize: 6 }}>▶</span>
            )}
          </button>
        ))}
      </div>

      {/* Submenu panel */}
      {openGroup && (
        <div
          className="rounded-xl p-2 shadow-xl pointer-events-auto"
          style={{ background: COLORS.sidebar, border: `1px solid ${COLORS.divider}` }}
        >
          {openGroup === "joints" && (
            <div className="flex flex-col gap-0.5" style={{ minWidth: 140 }}>
              {[
                { id: "pivot",  glyph: <PivotGlyph size={14} />,  label: "Pivot",  hint: "rotates freely" },
                { id: "weld",   glyph: <WeldGlyph size={14} />,   label: "Weld",   hint: "rigid lock" },
                { id: "ground", glyph: <GroundGlyph size={14} />, label: "Ground", hint: "pin to board" },
              ].map(j => (
                <button
                  key={j.id}
                  className="flex items-center gap-2 px-2 py-1.5 rounded-lg tool-btn"
                  style={{
                    background: st.tool === j.id ? COLORS.board : "transparent",
                    color: st.tool === j.id ? COLORS.shell : COLORS.ink,
                  }}
                  onClick={() => { dispatch({ type: "TOOL", tool: j.id }); setOpenGroup(null); }}
                >
                  {j.glyph}
                  <span className="mono text-xs">{j.label}</span>
                  <span className="mono text-[9px] ml-auto" style={{ opacity: 0.5 }}>{j.hint}</span>
                </button>
              ))}
            </div>
          )}


          {openGroup === "shapes" && (
            <div className="grid gap-1" style={{ gridTemplateColumns: "repeat(3, minmax(0, 1fr))" }}>
              {PALETTE.filter(p => ["triangle","square","pentagon"].includes(p.type)).map(def => {
                const isActive = st.palette === def.id;
                return (
                  <button key={def.id}
                    className="rounded-lg tool-btn flex flex-col items-center justify-center p-1"
                    style={{
                      background: isActive ? COLORS.board : COLORS.shellDeep,
                      border: `1px solid ${isActive ? COLORS.board : COLORS.divider}`,
                    }}
                    onClick={() => { dispatch({ type: "PALETTE", id: def.id }); setOpenGroup(null); }}
                  >
                    <PalettePreview def={def} big />
                    <div className="mono text-[9px]" style={{ color: isActive ? COLORS.shell : COLORS.inkDim }}>
                      {def.type.slice(0,4).toUpperCase()}
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ---------- Floating instruments toolbar ----------
function FloatingInstruments({ st, dispatch }) {
  const [expanded, setExpanded] = useState(false);
  const isBellActive = st.palette === "bell";

  const stampItems = [
    { id: "finger-right", glyph: "☞", label: "Point Right" },
    { id: "finger-left",  glyph: "☜", label: "Point Left" },
  ];

  return (
    <div className="absolute right-4 top-4 z-20 pointer-events-none">
      <div
        className="rounded-xl shadow-xl pointer-events-auto overflow-hidden"
        style={{ background: COLORS.sidebar, border: `1px solid ${COLORS.divider}`, minWidth: 44 }}
      >
        <button
          className="w-full flex items-center gap-2 px-2.5 py-2 tool-btn"
          style={{ color: expanded ? COLORS.ink : COLORS.inkDim }}
          onClick={() => setExpanded(e => !e)}
          title="Sounds & Graphics"
        >
          <Music size={15} />
          {expanded && <span className="mono text-[10px]" style={{ letterSpacing: "0.1em" }}>SOUNDS</span>}
          <ChevronRight size={11} style={{ marginLeft: expanded ? "auto" : 0, transform: expanded ? "rotate(90deg)" : "none", transition: "transform 150ms" }} />
        </button>

        {expanded && (
          <div className="border-t" style={{ borderColor: COLORS.divider }}>
            <div className="px-2 py-2 flex flex-col gap-1">
              <div className="mono text-[9px] px-1 pb-0.5" style={{ color: COLORS.inkDim, letterSpacing: "0.1em" }}>SOUNDS</div>
              <button
                className="flex items-center gap-2 px-2 py-1.5 rounded-lg tool-btn"
                style={{
                  background: isBellActive ? COLORS.board : "transparent",
                  color: isBellActive ? COLORS.shell : COLORS.ink,
                  border: `1px solid ${isBellActive ? COLORS.board : COLORS.divider}`,
                }}
                onClick={() => dispatch({ type: "PALETTE", id: "bell" })}
                title="Bell — triggers a note when any part passes over it"
              >
                <Bell size={13} />
                <span className="mono text-xs">Bell</span>
              </button>
            </div>
            <div className="px-2 pb-2 flex flex-col gap-1 border-t" style={{ borderColor: COLORS.divider }}>
              <div className="mono text-[9px] px-1 pt-2 pb-0.5" style={{ color: COLORS.inkDim, letterSpacing: "0.1em" }}>GRAPHICS</div>
              {stampItems.map(s => {
                const isActive = st.palette === s.id;
                return (
                  <button
                    key={s.id}
                    className="flex items-center gap-2 px-2 py-1.5 rounded-lg tool-btn"
                    style={{
                      background: isActive ? COLORS.board : "transparent",
                      color: isActive ? COLORS.shell : COLORS.ink,
                      border: `1px solid ${isActive ? COLORS.board : COLORS.divider}`,
                    }}
                    onClick={() => dispatch({ type: "PALETTE", id: s.id })}
                    title={s.label}
                  >
                    <span style={{ fontFamily: "'Noto Symbols 2', sans-serif", fontSize: 16, lineHeight: 1 }}>{s.glyph}</span>
                    <span className="mono text-xs">{s.label}</span>
                  </button>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// Miniature preview of the part in the palette
function PalettePreview({ def, big = false }) {
  const cellW = big ? 56 : 42;
  const cellH = big ? 44 : 32;
  // Fit the part inside the cell
  let svgW, svgH, scale, tx, ty;

  if (def.type === "strip" || def.type === "slottedStrip") {
    const n = def.size;
    const lengthU = (n - 1) + STRIP_W;
    scale = (cellW - 6) / (lengthU * GRID);
    scale = Math.min(scale, (cellH - 6) / (STRIP_W * GRID));
    svgW = cellW; svgH = cellH;
    tx = (cellW - (n - 1) * GRID * scale) / 2;
    ty = cellH / 2;
  } else if (def.type === "motor") {
    const r = 2; // visual radius in grid units
    scale = Math.min((cellW - 6) / (2 * r * GRID), (cellH - 6) / (2 * r * GRID));
    svgW = cellW; svgH = cellH;
    tx = cellW / 2;
    ty = cellH / 2;
  } else {
    const holes = getLocalHoles(def);
    const minX = Math.min(...holes.map(h => h.x));
    const maxX = Math.max(...holes.map(h => h.x));
    const minY = Math.min(...holes.map(h => h.y));
    const maxY = Math.max(...holes.map(h => h.y));
    const w = (maxX - minX) * GRID + 14;
    const h = (maxY - minY) * GRID + 14;
    scale = Math.min((cellW - 6) / w, (cellH - 6) / h);
    svgW = cellW; svgH = cellH;
    tx = cellW / 2 - ((minX + maxX) / 2) * GRID * scale;
    ty = cellH / 2 - ((minY + maxY) / 2) * GRID * scale;
  }

  const sampleParts = { type: def.type, size: def.size, x: 0, y: 0, rotation: 0 };

  return (
    <svg width={svgW} height={svgH} viewBox={`0 0 ${svgW} ${svgH}`}>
      <g transform={`translate(${tx}, ${ty}) scale(${scale})`}>
        <PartShape part={sampleParts} />
      </g>
    </svg>
  );
}

function PartGrid({ items, active, onPick, big = false }) {
  const cols = big ? 3 : 3;
  return (
    <div
      className="grid gap-1.5"
      style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}
    >
      {items.map(def => {
        const isActive = active === def.id;
        return (
          <button
            key={def.id}
            onClick={() => onPick(def.id)}
            className="relative rounded tool-btn flex flex-col items-center justify-center overflow-hidden"
            style={{
              background: isActive ? COLORS.board : COLORS.shellDeep,
              border: `1px solid ${isActive ? COLORS.board : COLORS.divider}`,
              padding: "6px 4px",
            }}
            title={partLabel(def)}
          >
            <PalettePreview def={def} big={big} />
            <div
              className="mono text-[9px] mt-1"
              style={{ color: isActive ? COLORS.shell : COLORS.inkDim, letterSpacing: "0.05em" }}
            >
              {def.type === "strip" || def.type === "slottedStrip" ? def.size : def.type.slice(0, 4).toUpperCase()}
            </div>
          </button>
        );
      })}
    </div>
  );
}


// ---------- Status chip ----------
function StatusChip({ st, hoverHole, simJammed }) {
  const parts = st.parts.length;
  const joints = st.joints.length;
  const mode =
    st.tool === "place" && st.palette ? `placing ${st.palette}` :
    st.tool === "pivot" ? "placing pivot" :
    st.tool === "weld" ? "placing weld" :
    st.tool === "ground" ? "placing ground" :
    st.tool === "delete" ? "delete mode" :
    "select";

  return (
    <div className="absolute left-4 bottom-4 flex items-center gap-2">
      <div
        className="mono text-[10px] px-2.5 py-1.5 rounded flex items-center gap-3"
        style={{
          background: COLORS.sidebar,
          color: COLORS.inkDim,
          border: `1px solid ${COLORS.divider}`,
          letterSpacing: "0.04em",
        }}
      >
        <span>{mode}</span>
        <span style={{ color: COLORS.divider }}>│</span>
        <span>{parts} part{parts !== 1 ? "s" : ""}</span>
        <span style={{ color: COLORS.divider }}>│</span>
        <span>{joints} joint{joints !== 1 ? "s" : ""}</span>
        {hoverHole && (
          <>
            <span style={{ color: COLORS.divider }}>│</span>
            <span>{hoverHole.x},{hoverHole.y}</span>
          </>
        )}
      </div>
      {simJammed && (
        <div
          className="mono text-[10px] px-2.5 py-1.5 rounded flex items-center gap-1.5"
          style={{
            background: COLORS.sidebar,
            color: COLORS.weld,
            border: `1px solid ${COLORS.weld}55`,
            letterSpacing: "0.04em",
          }}
        >
          <AlertTriangle size={11} />
          <span>Geometry impossible — motor paused</span>
        </div>
      )}
    </div>
  );
}
