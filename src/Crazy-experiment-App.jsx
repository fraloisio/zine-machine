import { useReducer, useState, useRef, useEffect, useCallback, useMemo } from "react";
import {
  MousePointer2, Undo2, Redo2, Hammer, Play, Pause,
  Anchor, Link2, Circle as CircleIcon, Info, Music, Waves, Sparkles,
  Bell, ChevronRight, AlignJustify, AlertTriangle, Hand, Plus, Minus
} from "lucide-react";

/* ============================================================
   ZINE MACHINE — Unified Build
   ============================================================ */

// ---------- Constants ----------
const GRID = 28;                   
const SECTION_COLS = 30;           
const SECTION_ROWS = 20;
const COLS = SECTION_COLS * 3;
const ROWS = SECTION_ROWS * 3;
const STRIP_W = 0.72;              
const HOLE_R_PART = 2.8;           
const HOLE_R_BOARD = 1.8;          
const JOINT_R = 8;                 
const ANGLE_SNAP = 15;             
const BOARD_PAD = 0.7;             
const MAX_HISTORY = 80;
const SELECT_STROKE = 2.5;         
const MOTOR_SPEED_DEG = 90;        

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
  { id: "strip",    type: "strip", label: "Strip Bar" },
  { id: "slot",     type: "slottedStrip", label: "Slotted Strip" },
  { id: "triangle", type: "triangle" },
  { id: "square",   type: "square" },
  { id: "pentagon", type: "pentagon" },
  { id: "motor",    type: "motor" },
  { id: "bell",     type: "bell" },
  { id: "finger-right", type: "stamp", glyph: "☞" },
  { id: "finger-left",  type: "stamp", glyph: "☜" },
];

// ---------- Geometry & Part Helpers ----------
function rotate({ x, y }, deg) {
  const r = deg * Math.PI / 180;
  return { x: x * Math.cos(r) - y * Math.sin(r), y: x * Math.sin(r) + y * Math.cos(r) };
}

function getLocalHoles(part) {
  switch (part.type) {
    case "strip":
    case "slottedStrip":
      return Array.from({ length: part.size || 3 }, (_, i) => ({ x: i, y: 0 }));
    case "triangle": {
      const s = 3;
      return [{ x: 0, y: 0 }, { x: s, y: 0 }, { x: s / 2, y: -s * Math.sqrt(3) / 2 }, { x: s / 2, y: -s * Math.sqrt(3) / 6 }];
    }
    case "square":
      return [{ x: 0, y: 0 }, { x: 2, y: 0 }, { x: 2, y: 2 }, { x: 0, y: 2 }, { x: 1, y: 1 }];
    case "pentagon": {
      const r = 1.7;
      const verts = Array.from({ length: 5 }, (_, i) => {
        const a = -Math.PI / 2 + i * (2 * Math.PI / 5);
        return { x: r * Math.cos(a) + r, y: r * Math.sin(a) + r };
      });
      return [...verts, { x: r, y: r }];
    }
    case "motor":
      return [{ x: 0, y: 0 }, { x: 2, y: 0 }, { x: 0, y: 2 }, { x: -2, y: 0 }, { x: 0, y: -2 }];
    default: return [{ x: 0, y: 0 }];
  }
}

function getPartHoleWorld(part, holeIndex) {
  const holes = getLocalHoles(part);
  const local = holes[holeIndex] || { x: 0, y: 0 };
  const rot = rotate(local, part.rotation || 0);
  return { x: part.x + rot.x, y: part.y + rot.y };
}

// ---------- Reducer ----------
const initialState = {
  parts: [],
  joints: [],
  selectedId: null,
  tool: "select",
  palette: null,
  mode: "build",
  nextId: 1,
  camera: { x: SECTION_COLS * GRID, y: SECTION_ROWS * GRID },
  zoom: 1,
};

function reducer(state, action) {
  switch (action.type) {
    case "LOAD_SAVE":
      return { ...state, ...action.data };
    case "TOOL":
      return { ...state, tool: action.tool, palette: null, selectedId: null };
    case "PALETTE":
      return { ...state, palette: action.id, tool: "place", selectedId: null };
    case "PAN":
      return { ...state, camera: { x: state.camera.x - action.dx, y: state.camera.y - action.dy } };
    case "ZOOM":
      return { ...state, zoom: Math.min(2, Math.max(0.5, state.zoom + action.delta)) };
    case "ADD_PART":
      return {
        ...state,
        parts: [...state.parts, { id: `p${state.nextId}`, ...action.part }],
        nextId: state.nextId + 1,
        tool: "select"
      };
    case "UPDATE_PART":
      return {
        ...state,
        parts: state.parts.map(p => p.id === action.id ? { ...p, ...action.updates } : p)
      };
    case "DELETE_SELECTED":
      if (!state.selectedId) return state;
      return {
        ...state,
        parts: state.parts.filter(p => p.id !== state.selectedId),
        joints: state.joints.filter(j => !j.partIds.includes(state.selectedId)),
        selectedId: null
      };
    default:
      return state;
  }
}

// ---------- Main App ----------
export default function App() {
  const [st, dispatch] = useReducer(reducer, initialState);
  const [drag, setDrag] = useState(null);
  const [elastic, setElastic] = useState(null);
  const svgRef = useRef(null);

  // Persistence (LocalStorage)
  useEffect(() => {
    const saved = localStorage.getItem("zine_machine_v3");
    if (saved) dispatch({ type: "LOAD_SAVE", data: JSON.parse(saved) });
  }, []);

  useEffect(() => {
    localStorage.setItem("zine_machine_v3", JSON.stringify({
      parts: st.parts, joints: st.joints, nextId: st.nextId
    }));
  }, [st.parts, st.joints, st.nextId]);

  // Keyboard Shortcuts (Delete)
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === "Backspace" || e.key === "Delete") dispatch({ type: "DELETE_SELECTED" });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const getMouseWorld = (e) => {
    const rect = svgRef.current.getBoundingClientRect();
    return {
      x: (e.clientX - rect.left + st.camera.x) / (GRID * st.zoom),
      y: (e.clientY - rect.top + st.camera.y) / (GRID * st.zoom)
    };
  };

  const onMouseDown = (e) => {
    const m = getMouseWorld(e);

    if (st.tool === "hand") {
      setDrag({ type: "pan", last: { x: e.clientX, y: e.clientY } });
      return;
    }

    if (st.tool === "place" && (st.palette === "strip" || st.palette === "slot")) {
      if (!elastic) {
        setElastic({ origin: m, current: m });
      } else {
        const dx = m.x - elastic.origin.x;
        const dy = m.y - elastic.origin.y;
        const size = Math.max(2, Math.round(Math.hypot(dx, dy)) + 1);
        const rotation = Math.round(Math.atan2(dy, dx) * 180 / Math.PI / 15) * 15;
        dispatch({
          type: "ADD_PART",
          part: { 
            type: st.palette === "strip" ? "strip" : "slottedStrip", 
            x: elastic.origin.x, y: elastic.origin.y, size, rotation 
          }
        });
        setElastic(null);
      }
      return;
    }

    // Centroid logic for shapes
    if (st.tool === "place" && st.palette && st.palette !== "strip" && st.palette !== "slot") {
        dispatch({ type: "ADD_PART", part: { type: st.palette, x: m.x, y: m.y, rotation: 0 }});
    }
  };

  const onMouseMove = (e) => {
    const m = getMouseWorld(e);
    if (drag?.type === "pan") {
      dispatch({ type: "PAN", dx: e.clientX - drag.last.x, dy: e.clientY - drag.last.y });
      setDrag({ ...drag, last: { x: e.clientX, y: e.clientY } });
    }
    if (elastic) setElastic({ ...elastic, current: m });
  };

  return (
    <div className="flex h-screen overflow-hidden select-none" style={{ background: COLORS.shell, color: COLORS.ink }}>
      <Sidebar st={st} dispatch={dispatch} />
      
      <div className="relative flex-1 bg-pink-600 overflow-hidden">
        <svg 
          ref={svgRef} 
          className="w-full h-full cursor-crosshair" 
          onMouseDown={onMouseDown} 
          onMouseMove={onMouseMove} 
          onMouseUp={() => setDrag(null)}
        >
          <g transform={`translate(${-st.camera.x}, ${-st.camera.y}) scale(${st.zoom})`}>
            {/* 3x3 Grid Dots */}
            {Array.from({ length: ROWS }).map((_, y) => 
              Array.from({ length: COLS }).map((_, x) => (
                <circle key={`${x}-${y}`} cx={x * GRID} cy={y * GRID} r={HOLE_R_BOARD} fill={COLORS.boardDot} opacity={0.4} />
              ))
            )}

            {/* Ghost Preview for Elastic Strip */}
            {elastic && <ElasticPreview origin={elastic.origin} current={elastic.current} type={st.palette} />}

            {/* Parts */}
            {st.parts.map(p => <Part key={p.id} part={p} selected={st.selectedId === p.id} />)}
          </g>
        </svg>

        <div className="absolute right-4 bottom-4 flex flex-col gap-2">
          <button className="p-2 bg-black/40 rounded" onClick={() => dispatch({ type: "ZOOM", delta: 0.1 })}><Plus size={18}/></button>
          <button className="p-2 bg-black/40 rounded" onClick={() => dispatch({ type: "ZOOM", delta: -0.1 })}><Minus size={18}/></button>
        </div>
      </div>
    </div>
  );
}

// ---------- Sub-Components ----------

function Sidebar({ st, dispatch }) {
  return (
    <div className="w-16 flex flex-col items-center py-4 gap-4" style={{ background: COLORS.sidebar, borderRight: `1px solid ${COLORS.divider}` }}>
      <button onClick={() => dispatch({ type: "TOOL", tool: "select" })} className={`p-2 rounded ${st.tool === "select" ? "bg-pink-500" : "hover:bg-white/10"}`}><MousePointer2 size={20}/></button>
      <button onClick={() => dispatch({ type: "TOOL", tool: "hand" })} className={`p-2 rounded ${st.tool === "hand" ? "bg-pink-500" : "hover:bg-white/10"}`}><Hand size={20}/></button>
      <div className="h-px w-8 bg-white/10" />
      {PALETTE.map(p => (
        <button key={p.id} onClick={() => dispatch({ type: "PALETTE", id: p.id })} className={`p-2 rounded ${st.palette === p.id ? 'bg-white/20' : 'hover:bg-white/10'}`}>
           <div className="w-6 h-6 border-2 border-dashed border-white/40 rounded-sm" />
        </button>
      ))}
    </div>
  );
}

function Part({ part, selected }) {
  const holes = getLocalHoles(part);
  const isStrip = part.type === "strip" || part.type === "slottedStrip";
  const w = ((part.size || 1) - 1) * GRID;

  return (
    <g transform={`translate(${part.x * GRID}, ${part.y * GRID}) rotate(${part.rotation || 0})`}>
      {selected && <rect x={-14} y={-14} width={w + 28} height={28} rx={14} fill="none" stroke={COLORS.select} strokeWidth={2} strokeDasharray="4 2" />}
      
      {isStrip ? (
        <>
          <rect x={-10} y={-10} width={w + 20} height={20} rx={10} fill={COLORS.part} stroke={COLORS.partEdge} strokeWidth={1.5} />
          {part.type === "slottedStrip" && <rect x={2} y={-3} width={w - 4} height={6} rx={3} fill={COLORS.slot} />}
        </>
      ) : (
        <path d={getShapePath(part.type)} fill={COLORS.part} stroke={COLORS.partEdge} strokeWidth={1.5} />
      )}

      {holes.map((h, i) => (
        <circle key={i} cx={h.x * GRID} cy={h.y * GRID} r={HOLE_R_PART} fill={COLORS.partHole} />
      ))}
    </g>
  );
}

function ElasticPreview({ origin, current, type }) {
  const dx = current.x - origin.x;
  const dy = current.y - origin.y;
  const dist = Math.max(1, Math.round(Math.hypot(dx, dy)));
  const angle = Math.round(Math.atan2(dy, dx) * 180 / Math.PI / 15) * 15;

  return (
    <g transform={`translate(${origin.x * GRID}, ${origin.y * GRID}) rotate(${angle})`} opacity={0.5}>
      <rect x={-10} y={-10} width={(dist * GRID) + 20} height={20} rx={10} fill={COLORS.part} stroke={COLORS.partEdge} strokeDasharray="4 2" />
      {Array.from({ length: dist + 1 }).map((_, i) => (
        <circle key={i} cx={i * GRID} cy={0} r={HOLE_R_PART} fill={COLORS.partHole} />
      ))}
    </g>
  );
}

function getShapePath(type) {
    if (type === "square") return "M -10 -10 H 66 V 66 H -10 Z";
    if (type === "triangle") return "M 0 -70 L 42 0 L -42 0 Z";
    return "M -10 -10 L 10 -10 L 10 10 L -10 10 Z";
}