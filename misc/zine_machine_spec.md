# Zine Machine — Interaction Spec
> Machine-readable design specification for the strip object interaction system.
> All measurements in grid units unless stated otherwise. 1 grid unit = 28px.

---

## Canvas

- Background: `#e53e7a` (hot pink)
- Dot grid: `#2a0a18`, radius `1.8px`, spacing `28px`, offset `14px 14px`
- Shell/sidebar: `#1a0f14`

---

## Colour Tokens

| Token | Hex | Usage |
|---|---|---|
| `part` | `#f4ecd6` | Strip pill fill |
| `edge` | `#1a0f14` | Strip pill stroke, hole fill |
| `hole` | `#1a0f14` | All hole dots |
| `select` | `#ffd23f` | Active handle, dashed track, pivot ring, arc |
| `ghost` | `#e07060` | Ghost handle |
| `scaling-fill` | `#d4899a` | Strip fill during scale drag |
| `scaling-holes` | `#8a3a50` | Hole colour during scale drag |

---

## Strip Geometry

```
GRID        = 28          // px per grid unit
STRIP_W     = 0.72        // strip width in grid units → 20.16px height
HOLE_R      = 2.8         // hole dot radius px
HANDLE_R    = 9           // active + ghost handle radius px
CAP_PAD     = (STRIP_W/2 * GRID) + HANDLE_R + 2  // px from last hole centre to handle centre
                          // = 10.08 + 9 + 2 = 21.08px
SIZE        = 5           // default strip hole count (demo uses 5)
```

**Strip pill:**
- Rect with `rx = ry = STRIP_W * GRID / 2 = 10.08px`
- Width: `(SIZE-1) * GRID + STRIP_W * GRID` = `(SIZE-1)*28 + 20.16`
- Origin `(x, y)` is at hole[0] world position

**Holes:**
- Count: `SIZE`, evenly spaced at `1 grid unit` intervals along the strip axis
- Local positions: `{ x: i, y: 0 }` for `i = 0..SIZE-1`
- World position: rotate local by `rotation` degrees, add `(part.x, part.y)`

**Pivot hole index:**
- Default: `0` (left end when rotation=0)
- Toggleable: `0` or `SIZE-1`
- The pivot hole is the anchor point — it does not move during rotation or scaling

**Active handle:**
- Sits `CAP_PAD` px past hole[SIZE-1] (or hole[0] if pivot=SIZE-1), along the strip axis
- Radius: `HANDLE_R = 9px`
- Fill: `#ffd23f` (gold)
- Stroke: `#1a0f14`, width `1.4px`

**Ghost handle:**
- Sits `CAP_PAD` px past the PIVOT end (opposite to active handle)
- Radius: `HANDLE_R = 9px` (same size as active)
- Fill: `#e07060` (salmon), opacity `0.7`
- Stroke: `#1a0f14`, width `1.4px`

---

## Interaction States

### 1. Idle
**Visual:** White pill + 5 black dots. Nothing else.  
**Cursor:** `Arrow`  
**Trigger:** Nothing selected. User clicked away or just placed object.

---

### 2. Selected
**Visual:**
- White pill + holes
- Dashed gold track line through strip body: colour `#ffd23f`, width `1.5px`, dasharray `4 3`
- **Pivot hole:** Same size as other holes (`r=2.8`), fill `#1a0f14`, gold ring outside (`r=4.6`, stroke `#ffd23f`, width `1.8px`)
- **Active handle:** Gold circle (`r=9`) outside far end, 2px gap from pill cap
- **Ghost handle:** Salmon circle (`r=9`) outside pivot end, 2px gap from pill cap
- **Axis line:** Gold dashed line from pivot hole to active handle (`#ffd23f`, width `1.5`, dasharray `3 3`, opacity `0.9`)
**Cursor:** `Move` (cross arrows) over body  
**Trigger:** User clicks strip body with select tool.

---

### 3. Rotation — Hover
**Visual:** Selected state + large dashed circle centred on pivot hole.  
- Circle radius = distance from pivot hole to active handle (full radius including cap pad)
- Circle: stroke `#ffd23f`, width `1.5px`, dasharray `7 5`, opacity `0.8`
**Cursor:** `Rotate/Top Right` SVG, placed outside the active handle along the radius direction.  
- Cursor rotation = `(radius_angle_degrees + 90) - 45`
- Where `radius_angle` = `atan2(handle.y - pivot.y, handle.x - pivot.x)`  
**Trigger:** Cursor hovers outside edge of active handle while selected.

---

### 4. Rotation — Dragging
**Visual:**
- Strip rotated at current angle around pivot hole
- Dashed rotation circle (same as hover)
- **Baseline:** Dashed line from pivot rightward to circle edge. Colour `#ffd23f`, width `1.5px`, dasharray `4 3`
- **Protractor arc:** From baseline (3 o'clock) sweeping to current strip angle.
  - Radius = distance from pivot to **last hole** (hole[SIZE-1] or hole[0]), NOT to handle
  - Stroke `#ffd23f`, width `2px`, round linecap
  - Sweep direction: clockwise (`sweep-flag=1`, `large-arc` flag set when angle > 180°)
- Active handle dot at current rotated position
**Cursor:** `Rotate/Top Right` SVG, no rotation transform applied.  
- Placed outside active handle along radius direction (same placement as hover)  
**Trigger:** Pointer down on outer zone of active handle, then drag.

---

### 5. Scaling — Hover
**Visual:** Selected state (handles visible).  
**Cursor:** `Resize/East West` SVG, centred on active handle dot, rotated to match strip axis angle (`rotDeg`).  
**Trigger:** Cursor hovers inside (inner zone) of active handle while selected.

---

### 6. Scaling — Active (dragging)
**Visual:**
- Strip pill fill changes to `#d4899a` (dusty pink)
- Hole dots change to `#8a3a50` (dark mauve)
- Active handle gold dot remains visible
- Ghost handle disappears
- Dashed track remains
**Cursor:** `Resize/East West` SVG, centred on active handle dot, rotated to match strip axis angle.  
**Trigger:** Pointer down on inner zone of active handle, then drag.  
**Behaviour:** Pivot hole stays fixed. Strip length changes. Active end follows cursor along axis.

---

### 7. Switch Handle
**Trigger:** User clicks the ghost handle.  
**Result:**
- Active handle moves to where ghost was (pivot end)
- Ghost handle moves to where active was (far end)
- Pivot hole index flips (`0` ↔ `SIZE-1`)
- All rotation and scaling now operates from the new active end

---

### 8. Drag & Drop — Grabbed
**Visual:** Strip as normal (no handles). Four-way move cursor centred on body.  
**Cursor:** `Move` (cross arrows)  
**Trigger:** Pointer down on pill body (not on a handle), then drag.  
**Behaviour:** Handles disappear for duration of drag. Strip snaps to dot grid on drop.

---

### 9. Drag & Drop — Dropped
**Visual:**
- Dashed ghost outline at origin position: stroke `#ffd23f`, width `1.5px`, dasharray `5 4`
- Ghost holes: gold dots at same radius as real holes (`r=2.8`), opacity `0.45`
- Dropped strip at new position (snapped to dot grid), normal appearance
- Move cursor on dropped strip
**Cursor:** `Move` (cross arrows)  
**Trigger:** Pointer up after drag.

---

## Handle Zones

Each handle has two interaction zones (no visual border between them — purely by cursor proximity):

| Zone | Location | Cursor | Action |
|---|---|---|---|
| Outer | Outside the handle edge | `Rotate/Top Right` (rotated) | Rotate |
| Inner | Inside the handle area | `Resize/East West` (rotated) | Scale |

---

## Cursor Reference

All cursors are macOS-native style SVGs (white fill, black stroke, drop shadow).  
Files are in `/Cursor/` subdirectories.

| State | Cursor File | Rotation Applied |
|---|---|---|
| Idle | `Cursor/Arrow.svg` | None |
| Selected (over body) | `Cursor/Move.svg` | None |
| Drag grabbed | `Cursor/Move.svg` | None |
| Drag dropped | `Cursor/Move.svg` | None |
| Rotation hover | `Cursor/Rotate/Top Right.svg` | `(atan2(h.y-p.y, h.x-p.x) * 180/π) + 90 - 45` |
| Rotation dragging | `Cursor/Rotate/Top Right.svg` | None (upright) |
| Scale hover | `Cursor/Resize/East West.svg` | Strip rotation angle (`rotDeg`) |
| Scale active | `Cursor/Resize/East West.svg` | Strip rotation angle (`rotDeg`) |

---

## Rotation Math

```js
// Pivot world position
pivot_world = {
  x: part.x + hole[pivotIdx].x * cos(rotRad) - hole[pivotIdx].y * sin(rotRad),
  y: part.y + hole[pivotIdx].x * sin(rotRad) + hole[pivotIdx].y * cos(rotRad)
}

// Active handle world position  
handle_local_x = (other_hole_idx * GRID) + CAP_PAD  // along local x axis
handle_world = {
  x: part.x + handle_local_x * cos(rotRad),
  y: part.y + handle_local_x * sin(rotRad)
}

// Rotation cursor angle
radius_angle = atan2(handle.y - pivot.y, handle.x - pivot.x)
cursor_rotation = (radius_angle * 180/π) + 90 - 45

// Protractor arc
arc_radius = distance(pivot_world, last_hole_world)  // NOT to handle
arc_start  = { x: pivot.x + arc_radius, y: pivot.y } // 3 o'clock
arc_end    = { x: pivot.x + arc_radius * cos(rotRad), y: pivot.y + arc_radius * sin(rotRad) }
large_arc  = normalizedAngle > 180 ? 1 : 0
sweep      = 1  // always clockwise
```

---

## Z-order (bottom to top)

1. Canvas background + dot grid
2. Strip pill body
3. Dashed track line
4. Hole dots
5. Rotation/scale overlays (circle, arc, baseline)
6. Ghost handle
7. Axis dashed line
8. Active handle dot
9. Cursor SVG
