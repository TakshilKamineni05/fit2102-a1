/**
 * Inside this file you will use the classes and functions from rx.js
 * to add visuals to the svg element in index.html, animate them, and make them interactive.
 *
 * Study and complete the tasks in observable exercises first to get ideas.
 *
 * Course Notes showing Asteroids in FRP: https://tgdwyer.github.io/asteroids/
 *
 * You will be marked on your functional programming style
 * as well as the functionality that you implement.
 *
 * Document your code!
 */

/*
AI Use Declaration 

I used ChatGPT (GPT-5 Thinking) to review and refine my FRP/RxJS architecture,
suggest alternative operator choices (e.g., reducer-centric pause, switchScan
session loop), and help draft the design document, over ~20 iterations.

I modified the outputs by:
- Rewriting all code into my own implementation and integrating it with my project.
- Renaming/adding types and comments to match course conventions.
- Implementing ghosts, pause, and CSV scheduling purely via scan in the reducer.
- Testing behaviours and tuning constants; removing any generated scaffolding.

I understand the code and can explain it.
*/

import "./style.css";

import {
    Observable,
    catchError,
    filter,
    fromEvent,
    interval,
    last,
    map,
    merge,
    of,
    scan,
    startWith,
    switchMap,
    switchScan,
    take,
    takeWhile,
    tap,
} from "rxjs";
import { fromFetch } from "rxjs/fetch";

/** ───────────────────────────── Constants ───────────────────────────── */

const Viewport = {
    CANVAS_WIDTH: 600,
    CANVAS_HEIGHT: 400,
} as const;

const Birb = {
    WIDTH: 42,
    HEIGHT: 30,
} as const;

const Physics = {
    GRAVITY: 1800, // px/s^2
    PIPE_SPEED: 160, // px/s leftward
} as const;

const Constants = {
    PIPE_WIDTH: 50,
    TICK_RATE_MS: 16, // simulation step (ms)
    SEED: 1234, // global RNG seed for determinism
    MAX_GHOSTS: 20, // keep at most N previous runs
} as const;

const LivesCfg = {
    START: 3,
    HIT_COOLDOWN_MS: 500,
} as const;

// User input helper types
type KeyCode = "Space" | "KeyP" | "KeyR";

/** ───────────────── RNG (deterministic; model-carried seed) ─────────────────
 * Linear congruential generator (as per unit examples).
 * All randomness is derived from State.rngSeed inside the reducer (Asteroids style).
 */
abstract class RNG {
    private static m = 0x80000000; // 2^31
    private static a = 1103515245;
    private static c = 12345;

    /** Next seed (pure arithmetic step) */
    static hash(seed: number): number {
        return (RNG.a * seed + RNG.c) % RNG.m;
    }
    /** Scale a seed to [-1,1] (pure) */
    static scale(seed: number): number {
        return (2 * seed) / (RNG.m - 1) - 1;
    }
}

/** Return next seed + a uniform [0,1) pseudo-random number (pure). */
const rand01 = (seed: number) => {
    const next = RNG.hash(seed);
    const u = (RNG.scale(next) + 1) / 2; // [0,1]
    return { seed: next >>> 0, u };
};
/** Linear interpolation helper. */
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

/** ───────────────────────────── Game types ───────────────────────────── */

type PipeSpec = Readonly<{
    gapY: number; // px
    gapH: number; // px
    timeMs: number; // ms from start
}>;

type Pipe = Readonly<{
    id: number;
    x: number;
    gapY: number;
    gapH: number;
    passed: boolean;
}>;

type Bird = Readonly<{ y: number; vy: number }>;

type GhostSample = Readonly<{ t: number; y: number }>;

/** Full immutable game state (Model). */
type State = Readonly<{
    t: number; // ms since run start
    bird: Bird;
    pipes: readonly Pipe[];
    score: number;
    lives: number;
    gameEnd: boolean;
    spawned: number;
    totalToSpawn: number;
    iFramesMs: number; // invulnerability window remaining (ms)
    paused: boolean;

    /** Deterministic RNG seed carried inside the model (single source of randomness). */
    rngSeed: number;

    /** Ghosting:
     *  - ghostNow: samples recorded during *this* run
     *  - ghostPrev: ALL previous runs (each a list of samples)
     */
    ghostNow: readonly GhostSample[];
    ghostPrev?: readonly (readonly GhostSample[])[];

    /** Spawn schedule (CSV) and pointer to next one to emit — held in the Model (Asteroids style). */
    specs: readonly PipeSpec[];
    nextSpecIdx: number;
}>;

const initialState: State = {
    t: 0,
    bird: { y: Viewport.CANVAS_HEIGHT / 2, vy: 0 },
    pipes: [],
    score: 0,
    lives: LivesCfg.START,
    gameEnd: false,
    spawned: 0,
    totalToSpawn: 0,
    iFramesMs: 0,
    paused: false,
    rngSeed: (Constants.SEED ^ 0x2c1b3c6d) >>> 0,
    ghostNow: [],
    ghostPrev: undefined,
    specs: [],
    nextSpecIdx: 0,
};

/** ───────────────────────────── Events (Actions) ───────────────────────────── */

type EvTick = Readonly<{ kind: "tick"; dt: number }>;
type EvFlap = Readonly<{ kind: "flap" }>; // no payload; vy computed inside reducer from State.rngSeed
type EvTogglePause = Readonly<{ kind: "pauseToggle" }>;
type Event = EvTick | EvFlap | EvTogglePause;

/**
 * Updates the state by proceeding one time step using a pure reducer.
 * No DOM or other effects here; the reducer returns a *new* State.
 * In MVC terms, this is the Model update function.
 */
const step = (s: State, e: Event): State => {
    switch (e.kind) {
        case "flap": {
            // Deterministic "random" flap strength derived from model RNG
            const { seed, u } = rand01(s.rngSeed);
            const vy = -450 + u * 60; // ~ -450..-390
            return { ...s, rngSeed: seed, bird: { ...s.bird, vy } };
        }

        case "pauseToggle":
            return { ...s, paused: !s.paused };

        case "tick": {
            // If paused or ended, freeze everything (time, spawns, i-frames, ghosts).
            if (s.paused || s.gameEnd) return s;

            const dtMs = e.dt;
            const dt = dtMs / 1000;

            // Advance simulated time first (used by spawns & ghost sampling)
            const tNext = s.t + dtMs;

            // Schedule any CSV spawns whose time <= tNext
            let idx = s.nextSpecIdx;
            const newPipes: Pipe[] = [];
            while (idx < s.specs.length && s.specs[idx].timeMs <= tNext) {
                const spec = s.specs[idx];
                newPipes.push({
                    id: idx,
                    x: Viewport.CANVAS_WIDTH + 20,
                    gapY: spec.gapY,
                    gapH: spec.gapH,
                    passed: false,
                });
                idx++;
            }

            // Physics: integrate vy, clamp y to viewport bounds
            const vyNext = s.bird.vy + Physics.GRAVITY * dt;
            const yRaw = s.bird.y + vyNext * dt;
            const minY = Birb.HEIGHT / 2;
            const maxY = Viewport.CANVAS_HEIGHT - Birb.HEIGHT / 2;
            const yClamped = clamp(yRaw, minY, maxY);

            // Record a ghost sample for this run
            const ghostNow = [...s.ghostNow, { t: tNext, y: yClamped }];

            // Move pipes; cull offscreen
            const moved = [...s.pipes, ...newPipes].map(p => ({
                ...p,
                x: p.x - Physics.PIPE_SPEED * dt,
            }));
            const visible = moved.filter(p => p.x + Constants.PIPE_WIDTH > 0);

            // Score: increment when passing pipe trailing edge
            const birdX = Viewport.CANVAS_WIDTH * 0.3;
            let score = s.score;
            const pipes = visible.map(p => {
                if (!p.passed && p.x + Constants.PIPE_WIDTH < birdX) {
                    score += 1;
                    return { ...p, passed: true };
                }
                return p;
            });

            // Collisions: with pipes (using yClamped) or world edges
            const firstHitPipe = pipes.find(p => collides(yClamped, p));
            const hitPipe = !!firstHitPipe;

            const hitTopEdge = yRaw <= minY;
            const hitBottomEdge = yRaw >= maxY;

            // Determine which side of the gap we hit using yClamped (deterministic)
            const hitTopPipe = !!firstHitPipe && yClamped <= firstHitPipe.gapY;
            const hitBottomPipe =
                !!firstHitPipe && yClamped > firstHitPipe.gapY;

            const hit = hitPipe || hitTopEdge || hitBottomEdge;

            // Invulnerability countdown
            const nextIFrames = Math.max(0, s.iFramesMs - dtMs);

            let lives = s.lives;
            let vyAfter = vyNext;
            let rngSeed = s.rngSeed;

            if (hit && nextIFrames === 0) {
                // Lose a life and bounce with deterministic randomised magnitude
                lives = Math.max(0, s.lives - 1);

                const next = rand01(rngSeed);
                rngSeed = next.seed;
                const magDown = lerp(250, 300, next.u);
                const magUp = -lerp(300, 500, next.u);

                if (hitTopEdge || hitTopPipe) vyAfter = magDown;
                else if (hitBottomEdge || hitBottomPipe) vyAfter = magUp;
            }

            const allSpawned = idx >= s.specs.length;
            const cleared = pipes.length === 0 && allSpawned;
            const gameEnd = lives <= 0 || cleared;

            return {
                ...s,
                t: tNext,
                bird: { y: yClamped, vy: vyAfter },
                pipes,
                score,
                lives,
                gameEnd,
                iFramesMs:
                    hit && nextIFrames === 0
                        ? LivesCfg.HIT_COOLDOWN_MS
                        : nextIFrames,
                ghostNow,
                rngSeed,
                spawned: s.spawned + newPipes.length,
                totalToSpawn: s.specs.length,
                nextSpecIdx: idx,
            };
        }
    }

    // Exhaustiveness guard (keeps ADT handling honest)
    const _exhaustive: never = e;
    return s;
};

/** ───────────────────────────── Rendering (View / side-effects) ───────────────────────────── */

/**
 * Bring an SVG element to the foreground.
 * @param elem SVG element to bring to the foreground.
 */
const bringToForeground = (elem: SVGElement): void => {
    elem.parentNode?.appendChild(elem);
};
/**
 * Show a SVG element and bring to foreground.
 * @param elem SVG element to display.
 */
const show = (elem: SVGElement): void => {
    elem.setAttribute("visibility", "visible");
    bringToForeground(elem);
};
/**
 * Hide a SVG element.
 * @param elem SVG element to hide.
 */
const hide = (elem: SVGElement): void => {
    elem.setAttribute("visibility", "hidden");
};
/**
 * Create an SVG element with given attributes.
 * @param namespace SVG namespace URI.
 * @param name Element name.
 * @param props Attribute map.
 * @returns The created SVG element.
 */
const createSvgElement = (
    namespace: string | null,
    name: string,
    props: Record<string, string> = {},
): SVGElement => {
    const elem = document.createElementNS(namespace, name) as SVGElement;
    Object.entries(props).forEach(([k, v]) => elem.setAttribute(k, v));
    return elem;
};

/**
 * Returns a function that renders State to the SVG canvas.
 * In MVC terms, this is the View update function (the sole impure section).
 */
const render = (): ((s: State) => void) => {
    const svg = document.querySelector("#svgCanvas") as SVGSVGElement;
    svg.setAttribute(
        "viewBox",
        `0 0 ${Viewport.CANVAS_WIDTH} ${Viewport.CANVAS_HEIGHT}`,
    );

    // Text fields (simple HUD)
    const livesText = document.querySelector(
        "#livesText",
    ) as HTMLElement | null;
    const scoreText = document.querySelector(
        "#scoreText",
    ) as HTMLElement | null;

    // Create main bird once
    let birdImg = document.querySelector("#bird") as SVGImageElement | null;
    if (!birdImg) {
        birdImg = createSvgElement(svg.namespaceURI, "image", {
            id: "bird",
            href: "assets/birb.png",
            x: `${Viewport.CANVAS_WIDTH * 0.3 - Birb.WIDTH / 2}`,
            y: `${Viewport.CANVAS_HEIGHT / 2 - Birb.HEIGHT / 2}`,
            width: `${Birb.WIDTH}`,
            height: `${Birb.HEIGHT}`,
        }) as SVGImageElement;
        svg.appendChild(birdImg);
    }

    // Ghost image pool: created on demand; we will show N previous runs at once.
    const ghostImgs: SVGImageElement[] = [];
    const ghostAt = (i: number) => {
        while (ghostImgs.length <= i) {
            const img = createSvgElement(svg.namespaceURI, "image", {
                href: "assets/birb.png",
                x: `${Viewport.CANVAS_WIDTH * 0.3 - Birb.WIDTH / 2}`,
                y: `${Viewport.CANVAS_HEIGHT / 2 - Birb.HEIGHT / 2}`,
                width: `${Birb.WIDTH}`,
                height: `${Birb.HEIGHT}`,
                opacity: "0.3",
                visibility: "hidden",
            }) as SVGImageElement;
            svg.appendChild(img);
            ghostImgs.push(img);
        }
        return ghostImgs[i];
    };

    // Maintain pipe element pairs by id
    const pipeEls = new Map<
        number,
        { top: SVGRectElement; bot: SVGRectElement }
    >();

    return (s: State) => {
        // HUD
        if (scoreText) scoreText.textContent = `Score: ${s.score}`;
        if (livesText) livesText.textContent = `Lives: ${s.lives}`;

        // Bird position
        birdImg!.setAttribute("y", String(s.bird.y - Birb.HEIGHT / 2));

        // Render all ghosts; hide each when its trace finishes
        const runs = s.ghostPrev ?? [];
        for (let i = 0; i < runs.length; i++) {
            const trace = runs[i];
            const img = ghostAt(i);
            if (trace.length === 0) {
                img.setAttribute("visibility", "hidden");
                continue;
            }
            const lastT = trace[trace.length - 1].t;
            if (s.t <= lastT) {
                const idx = binarySearchLastLE(trace, s.t, smp => smp.t);
                const gy = idx >= 0 ? trace[idx].y : trace[0].y;
                img.setAttribute("y", String(gy - Birb.HEIGHT / 2));
                // Older ghosts are fainter
                const alpha = 0.18 + 0.6 * ((i + 1) / Math.max(1, runs.length));
                img.setAttribute("opacity", alpha.toFixed(2));
                img.setAttribute("visibility", "visible");
            } else {
                img.setAttribute("visibility", "hidden");
            }
        }
        // Hide any unused pooled ghost images
        for (let i = runs.length; i < ghostImgs.length; i++) {
            ghostImgs[i].setAttribute("visibility", "hidden");
        }

        // Pipes
        const seen = new Set<number>();
        for (const p of s.pipes) {
            let pair = pipeEls.get(p.id);
            if (!pair) {
                const top = createSvgElement(svg.namespaceURI, "rect", {
                    fill: "green",
                }) as SVGRectElement;
                const bot = createSvgElement(svg.namespaceURI, "rect", {
                    fill: "green",
                }) as SVGRectElement;
                svg.appendChild(top);
                svg.appendChild(bot);
                pair = { top, bot };
                pipeEls.set(p.id, pair);
            }
            const topH = Math.max(0, p.gapY - p.gapH / 2);
            const botY = p.gapY + p.gapH / 2;
            const botH = Math.max(0, Viewport.CANVAS_HEIGHT - botY);

            pair.top.setAttribute("x", String(p.x));
            pair.top.setAttribute("y", "0");
            pair.top.setAttribute("width", String(Constants.PIPE_WIDTH));
            pair.top.setAttribute("height", String(topH));

            pair.bot.setAttribute("x", String(p.x));
            pair.bot.setAttribute("y", String(botY));
            pair.bot.setAttribute("width", String(Constants.PIPE_WIDTH));
            pair.bot.setAttribute("height", String(botH));

            seen.add(p.id);
        }
        // Remove offscreen pipes' elements
        for (const [id, pair] of pipeEls) {
            if (!seen.has(id)) {
                pair.top.remove();
                pair.bot.remove();
                pipeEls.delete(id);
            }
        }

        // Game Over overlay
        let overlay = document.querySelector(
            "#gameOver",
        ) as SVGTextElement | null;
        if (s.gameEnd) {
            if (!overlay) {
                overlay = createSvgElement(svg.namespaceURI, "text", {
                    id: "gameOver",
                    x: String(Viewport.CANVAS_WIDTH / 2 - 120),
                    y: String(Viewport.CANVAS_HEIGHT / 2),
                    "font-size": "28",
                    fill: "white",
                }) as SVGTextElement;
                overlay.textContent = "Game Over — press R";
                svg.appendChild(overlay);
            }
        } else if (overlay) {
            overlay.remove();
        }

        // Paused overlay (purely a view concern)
        let pausedLabel = document.querySelector(
            "#pausedLabel",
        ) as SVGTextElement | null;
        if (s.paused && !s.gameEnd) {
            if (!pausedLabel) {
                pausedLabel = createSvgElement(svg.namespaceURI, "text", {
                    id: "pausedLabel",
                    x: String(Viewport.CANVAS_WIDTH / 2 - 80),
                    y: String(40),
                    "font-size": "20",
                    fill: "yellow",
                }) as SVGTextElement;
                pausedLabel.textContent = "Paused — press P";
                svg.appendChild(pausedLabel);
            }
        } else if (pausedLabel) {
            pausedLabel.remove();
        }
    };
};

/** ───────────────────────────── Pure helpers ───────────────────────────── */

/** Clamp numeric value to [lo, hi]. */
const clamp = (v: number, lo: number, hi: number) =>
    v < lo ? lo : v > hi ? hi : v;

/** AABB overlap check vs. two pipe rectangles.  */
const collides = (birdY: number, p: Pipe): boolean => {
    // Bird rect
    const bx1 = Viewport.CANVAS_WIDTH * 0.3 - Birb.WIDTH / 2;
    const bx2 = Viewport.CANVAS_WIDTH * 0.3 + Birb.WIDTH / 2;
    const by1 = birdY - Birb.HEIGHT / 2;
    const by2 = birdY + Birb.HEIGHT / 2;

    // Top pipe rect
    const tx1 = p.x,
        tx2 = p.x + Constants.PIPE_WIDTH,
        ty1 = 0,
        ty2 = p.gapY - p.gapH / 2;
    // Bottom pipe rect
    const bx_ = p.x,
        bx2_ = p.x + Constants.PIPE_WIDTH,
        by1_ = p.gapY + p.gapH / 2,
        by2_ = Viewport.CANVAS_HEIGHT;

    const overlap = (
        ax1: number,
        ay1: number,
        ax2: number,
        ay2: number,
        cx1: number,
        cy1: number,
        cx2: number,
        cy2: number,
    ) => ax1 < cx2 && ax2 > cx1 && ay1 < cy2 && ay2 > cy1;

    return (
        overlap(bx1, by1, bx2, by2, tx1, ty1, tx2, ty2) ||
        overlap(bx1, by1, bx2, by2, bx_, by1_, bx2_, by2_)
    );
};

/** Binary search for the last index with key <= t (for ghost playback). */
function binarySearchLastLE<T>(
    arr: readonly T[],
    t: number,
    get: (x: T) => number,
): number {
    let lo = 0,
        hi = arr.length - 1,
        ans = -1;
    while (lo <= hi) {
        const mid = (lo + hi) >> 1,
            v = get(arr[mid]);
        if (v <= t) {
            ans = mid;
            lo = mid + 1;
        } else {
            hi = mid - 1;
        }
    }
    return ans;
}

/** ───────────────────────────── CSV parsing ─────────────────────────────
 * Expects header: gap_y,gap_height,time with gap_* in [0,1] and time in seconds.
 */
const parseCsv = (text: string): readonly PipeSpec[] => {
    const [header, ...rows] = text.trim().split(/\r?\n/).filter(Boolean);
    const h = header.toLowerCase().replace(/\s/g, "");
    if (!/^gap_y,gap_height,time$/.test(h))
        throw new Error("CSV header must be: gap_y,gap_height,time");
    return rows.map(line => {
        const [gy, gh, t] = line.split(",").map(Number);
        return {
            gapY: gy * Viewport.CANVAS_HEIGHT,
            gapH: gh * Viewport.CANVAS_HEIGHT,
            timeMs: t * 1000,
        } as PipeSpec;
    });
};

/** ───────────────────────────── state$ (one run) ─────────────────────────────
 * Build a single game run as a stream of State values from inputs & time.
 * - clock: interval ticks (always produced; pause handled *inside* the Model)
 * - inputs: space$, pause$
 * - pure state: scan(step, initialState)
 * - effects: handled by the top-level subscribe(render)
 */
export const state$ = (
    csvContents: string,
    ghostPrev?: readonly (readonly GhostSample[])[],
): Observable<State> => {
    /** Key streams utility: filter to specific key (ignore key auto-repeat). */
    const keyDown = (code: KeyCode) =>
        fromEvent<KeyboardEvent>(window, "keydown").pipe(
            filter(e => e.code === code && !e.repeat),
            tap(e => {
                // Input hygiene: prevent page scroll on Space
                if (code === "Space") e.preventDefault();
            }),
        );

    // Space → flap (no payload; vy computed from RNG in reducer)
    const flap$: Observable<EvFlap> = keyDown("Space").pipe(
        map(() => ({ kind: "flap" }) as const),
    );

    // Pause toggles a flag *in the reducer* (Asteroids style)
    const pauseToggleEv$ = keyDown("KeyP").pipe(
        map((): EvTogglePause => ({ kind: "pauseToggle" })),
    );

    /** Clock: discrete simulation steps (no external pause gating). */
    const tick$: Observable<EvTick> = interval(Constants.TICK_RATE_MS).pipe(
        map(() => ({ kind: "tick", dt: Constants.TICK_RATE_MS }) as const),
    );

    const specs = parseCsv(csvContents);

    const init: State = {
        ...initialState,
        totalToSpawn: specs.length,
        specs,
        nextSpecIdx: 0,
        ghostNow: [],
        ghostPrev,
    };

    // Merge all events and reduce to State. Complete when the game run ends.
    const events$: Observable<Event> = merge(tick$, flap$, pauseToggleEv$);
    return events$.pipe(
        scan(step, init),
        startWith(init),
        takeWhile(s => !s.gameEnd, true),
    );
};

/** ───────────────────────────── Program entry point ─────────────────────────────
 * The following simply runs your main function on window load. Make sure to leave it in place.
 * You should not need to change this, beware if you are.
 */
if (typeof window !== "undefined") {
    const { protocol, hostname, port } = new URL(import.meta.url);
    const baseUrl = `${protocol}//${hostname}${port ? `:${port}` : ""}`;
    const csvUrl = `${baseUrl}/assets/map.csv`;

    // Fetch the CSV (with a tiny fallback so the game still runs if fetch fails).
    const csv$ = fromFetch(csvUrl).pipe(
        switchMap(response => {
            if (response.ok) return response.text();
            throw new Error(`Fetch error: ${response.status}`);
        }),
        catchError(err => {
            console.error("Error fetching the CSV file:", err);
            return of(
                "gap_y,gap_height,time\n0.5,0.25,1\n0.6,0.23,3\n0.4,0.22,5",
            );
        }),
    );

    // Wait for first user click to start (ensures focus for key events).
    const click$ = fromEvent(document.body, "mousedown").pipe(
        take(1),
        tap(() => (document.body as HTMLElement).focus()),
    );

    // 'R' to restart between runs (keeps ghosts).
    const keyDown = (code: KeyCode) =>
        fromEvent<KeyboardEvent>(window, "keydown").pipe(
            filter(e => e.code === code && !e.repeat),
        );
    const restart$ = keyDown("KeyR");

    // Build a single renderer and use it for all runs.
    const renderer = render();

    // FRP Core:
    // 1) clock: tick$ inside state$
    // 2) inputs: space$, pause$, restart$
    // 3) pure state: scan(step, initialState)
    // 4) effects: render() called from the single subscription (via tap)
    csv$.pipe(
        switchMap(contents =>
            click$.pipe(
                switchMap(() =>
                    restart$.pipe(
                        startWith(null),
                        // Each run: stream States (tap to render), then at completion keep its ghost trace.
                        switchScan(
                            (
                                prevRuns: readonly (readonly GhostSample[])[],
                                _ev: KeyboardEvent | null,
                            ) =>
                                state$(contents, prevRuns).pipe(
                                    tap(renderer),
                                    last(), // final State of the run
                                    map(s => {
                                        const appended = [
                                            ...prevRuns,
                                            s.ghostNow,
                                        ] as const;
                                        // Bound memory to MAX_GHOSTS most recent runs
                                        return appended.slice(
                                            -Constants.MAX_GHOSTS,
                                        );
                                    }),
                                ),
                            [] as readonly (readonly GhostSample[])[],
                        ),
                    ),
                ),
            ),
        ),
    ).subscribe();
}
