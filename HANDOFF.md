# Zine Machine — Handoff Brief

A React-based linkage mechanism simulator inspired by the paper Zine Machines kit (Meccano-style strips and brads on a perforated board). Long-term goal: a visual, modular sampler where mechanisms trigger sound-producing modules. Round 1 builds the construction surface only; sound comes later.

## Current state

Round 1 is complete. Single file: `src/App.jsx`. What works:

- Perforated 30×20 board, pink with dark holes
- Palette: strips 3–8, slotted strips 3–8, triangle, square, pentagon
- Place parts by clicking a palette item (shows ghost preview that snaps to nearest hole) then clicking the board
- Select, move (with grip offset), delete
- Rotation handle on selected parts, 15° snap, plus R / Shift+R keyboard shortcut
- Pivot, Weld, Ground joint tools with color-coded pins (green / red / blue)
- Undo / redo (⌘Z, ⌘⇧Z), Clear
- Right sidebar reserved with locked placeholder slots for future instrument modules

## Project setup

If starting from scratch:

```bash
npm create vite@latest zine-machine -- --template react
cd zine-machine
npm install
npm install lucide-react
```

Tailwind quick path (for prototyping, not production):

```css
/* src/index.css */
@import "https://cdn.jsdelivr.net/npm/tailwindcss@3/dist/tailwind.min.css";
```

Then replace `src/App.jsx` with the current file and `npm run dev`.

For proper Tailwind setup later: `npm install -D tailwindcss@3 postcss autoprefixer && npx tailwindcss init -p`, then configure `tailwind.config.js` content paths.

## Architecture

- **State**: single `useReducer`. Action types include `ADD_PART`, `UPDATE_PART` (snapshotting), `UPDATE_PART_LIVE` (non-snapshotting, for drag), `SNAPSHOT`, `ADD_JOINT`, `DELETE_PART`, `DELETE_JOINT`, `UNDO`, `REDO`, `TOOL`, `PALETTE`, `MODE`, `SELECT`, `CLEAR`.
- **Geometry**: parts have `{x, y, rotation}` where `(x, y)` is the anchor hole in grid coordinates. `getLocalHoles(part)` returns all hole positions in local space; `worldHoles(part)` transforms to world space.
- **Rendering**: everything is SVG. Parts are drawn inside a transformed `<g>` (translate + rotate). Joints are drawn separately on top.
- **Drag model**: mousedown on a part dispatches `SNAPSHOT` once, then pointermove dispatches `UPDATE_PART_LIVE` (no history spam). Grip offset is preserved so the anchor does not teleport to the cursor.
- **Joint placement**: when a joint tool is active, transparent hotspot circles are rendered over every valid hole. `partHolesByGrid` is a `Map` keyed by `"i,j"` used to find which parts share a hole.

## Decisions already made

- Iterative constraint solver (position-based dynamics) for Round 2. Not analytical.
- Palette-only placement. No free-drawing of arbitrary-length strips.
- Joint placement is an explicit tool (pick tool, then click hole). Not automatic.
- Angle snap 15°. Anchor-hole-snaps-to-grid on placement and move.
- Triangle is equilateral side 3, square is 2×2 at corners, pentagon is regular radius 1.7. Only the anchor is guaranteed grid-aligned after rotation.

## Roadmap

### Round 2: animation

1. Iterative PBD constraint solver running on `requestAnimationFrame`
   - Constraints: rigid distance between holes on the same part; joint coincidence (pivot / weld / ground); welds also enforce shared angular frame between the two parts.
   - Start with ~10 Gauss-Seidel iterations per frame.
2. Drag-to-animate: in Play mode, dragging any point becomes a soft target that the solver pulls toward.
3. DOF indicator: Locked (0) / Movable (1) / Loose (2+) / Over-constrained. Computable as `3 * parts - constraints_count` with slot constraints counting as 1 instead of 2.
4. Slotted strip behavior: a pin through a slotted strip is constrained to the line segment of the slot, not a fixed hole.

### Round 3: polish

- Motor on pivot or ground joint, speed control, play/pause
- Save / load as JSON
- Export board as PNG
- Per-mechanism trace / trigger instrumentation to prepare for sound modules on the right sidebar

## Style and constraints

- Fonts: DM Serif Display (headings), DM Sans (body), DM Mono (UI labels). Loaded via Google Fonts `@import` inside the `<style>` block.
- Colors are centralized in a `COLORS` object at the top. Do not hardcode hex elsewhere.
- No browser storage (no `localStorage`, `sessionStorage`, cookies). State is in memory only. Later rounds will add JSON export for persistence.
- No external images. All visuals are SVG.
- Keep the single-file structure for Round 2. Only split into multiple files when the solver implementation justifies it (probably a separate `solver.js` or `solver.ts`).

## Francesco's preferences

- Concise, direct prose. No AI-slop phrasing, no excessive em dashes.
- Code: keep it readable and commented where geometry or reducer logic is non-obvious. Don't over-abstract.
- When adding features, match the existing aesthetic (risograph zine, hot pink board, cream parts, DM font family).
- Push back honestly when something in my request is unclear or likely to cause problems. Do not just agree and build the wrong thing.

## Known limits in Round 1 (intentional, do not fix in Round 2 unless asked)

- No pan or zoom. Board fits viewport.
- Play mode toggle exists but is inert.
- Rigid shapes (triangle, pentagon) do not grid-align on rotation except at special angles. Accepted.
- No collision detection between parts.
- No touch optimization yet (uses pointer events, which handle touch, but no pinch-zoom or two-finger gestures).
- Clear uses `window.confirm()`. Replace with a proper modal in Round 3 if needed.

## What to verify before extending

Place a 6-strip, rotate it 30°, cross it with a 4-strip, add a pivot where they meet. Confirm all three joint types render correctly and that undo / redo survives a drag. Confirm the rotation handle works on the pentagon.
