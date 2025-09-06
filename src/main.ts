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

// test commit
import "./style.css";

import {
    Observable,
    catchError,
    filter,
    fromEvent,
    interval,
    map,
    merge,
    scan,
    switchMap,
    take,
    startWith,
    takeWhile,
    timer,
    tap,
    of,
    switchScan,
    last,
} from "rxjs";
import { fromFetch } from "rxjs/fetch";

/** Constants */

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
    TICK_RATE_MS: 16, // smoother updates (keep name; just tuned)
    SEED: 1234, // RNG seed
} as const;

const LivesCfg = {
    START: 3000, // lives at the beginning
    HIT_COOLDOWN_MS: 500, // grace period after a hit so we don't lose multiple lives at once
    BOUNCE_VY: -350, // upward bounce after a hit (feels responsive)
} as const;

// User input
type Key = "Space";

/** ───────────── RNG (from your jumping-dot example) ───────────── */

abstract class RNG {
    private static m = 0x80000000; // 2^31
    private static a = 1103515245;
    private static c = 12345;

    public static hash = (seed: number): number =>
        (RNG.a * seed + RNG.c) % RNG.m;

    public static scale = (hash: number): number =>
        (2 * hash) / (RNG.m - 1) - 1; // [-1, 1]
}

export function createRngStreamFromSource<T>(source$: Observable<T>) {
    return function createRngStream(
        seed: number = Constants.SEED,
    ): Observable<number> {
        return source$.pipe(
            scan(
                acc => {
                    const nextHash = RNG.hash(acc.seed);
                    const value = RNG.scale(nextHash);
                    return { seed: nextHash, value };
                },
                { seed, value: 0 },
            ),
            map(s => s.value),
        );
    };
}

/** ───────────── Game types ───────────── */

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

type State = Readonly<{
    t: number;
    bird: Bird;
    pipes: readonly Pipe[];
    score: number;
    lives: number;
    gameEnd: boolean; // kept from your original type
    spawned: number;
    totalToSpawn: number;
    iFramesMs: number; // NEW: remaining hit-cooldown ms (invulnerability window)
    ghostNow: readonly GhostSample[];
    ghostPrev?: readonly GhostSample[];
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
    ghostNow: [],
    ghostPrev: undefined,
};

/** Events */
type EvTick = Readonly<{ kind: "tick"; dt: number }>;
type EvFlap = Readonly<{ kind: "flap"; vy: number }>; // randomised vy from your dot logic
type EvSpawn = Readonly<{ kind: "spawn"; id: number; spec: PipeSpec }>;
type Event = EvTick | EvFlap | EvSpawn;

/**
 * Updates the state by proceeding with one time step.
 *
 * (Your original tick function is kept below, unused by the new reducer,
 * to honour the “don’t remove originals” instruction.)
 */
const tick = (s: State) => s;

/** Rendering (side effects) — your helpers kept intact */

const bringToForeground = (elem: SVGElement): void => {
    elem.parentNode?.appendChild(elem);
};
const show = (elem: SVGElement): void => {
    elem.setAttribute("visibility", "visible");
    bringToForeground(elem);
};
const hide = (elem: SVGElement): void => {
    elem.setAttribute("visibility", "hidden");
};
const createSvgElement = (
    namespace: string | null,
    name: string,
    props: Record<string, string> = {},
): SVGElement => {
    const elem = document.createElementNS(namespace, name) as SVGElement;
    Object.entries(props).forEach(([k, v]) => elem.setAttribute(k, v));
    return elem;
};

const render = (): ((s: State) => void) => {
    // Canvas elements
    const gameOver = document.querySelector("#gameOver") as SVGElement | null;
    const container = document.querySelector("#main") as HTMLElement | null;

    // Text fields
    const livesText = document.querySelector(
        "#livesText",
    ) as HTMLElement | null;
    const scoreText = document.querySelector(
        "#scoreText",
    ) as HTMLElement | null;

    const svg = document.querySelector("#svgCanvas") as SVGSVGElement;

    svg.setAttribute(
        "viewBox",
        `0 0 ${Viewport.CANVAS_WIDTH} ${Viewport.CANVAS_HEIGHT}`,
    );

    // Create bird once
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

    // Maintain pipe elements keyed by ID
    const pipeEls = new Map<
        number,
        { top: SVGRectElement; bot: SVGRectElement }
    >();

    return (s: State) => {
        // Update HUD
        if (scoreText) scoreText.textContent = `Score: ${s.score}`;
        if (livesText) livesText.textContent = `Lives: ${s.lives}`;

        // Update bird Y
        birdImg!.setAttribute("y", String(s.bird.y - Birb.HEIGHT / 2));

        // Ensure/render each pipe
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
        // Remove elements for pipes no longer in state
        for (const [id, pair] of pipeEls) {
            if (!seen.has(id)) {
                pair.top.remove();
                pair.bot.remove();
                pipeEls.delete(id);
            }
        }

        // Game over overlay
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
    };
};

/** ───────────── Pure helpers ───────────── */

const clamp = (v: number, lo: number, hi: number) =>
    v < lo ? lo : v > hi ? hi : v;

const collides = (bird: Bird, p: Pipe): boolean => {
    // Bird rect
    const bx1 = Viewport.CANVAS_WIDTH * 0.3 - Birb.WIDTH / 2;
    const bx2 = Viewport.CANVAS_WIDTH * 0.3 + Birb.WIDTH / 2;
    const by1 = bird.y - Birb.HEIGHT / 2;
    const by2 = bird.y + Birb.HEIGHT / 2;

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

/** ───────────── Reducer (now with lives logic) ───────────── */

const step = (s: State, e: Event): State => {
    switch (e.kind) {
        case "spawn": {
            const p: Pipe = {
                id: e.id,
                x: Viewport.CANVAS_WIDTH + 20,
                gapY: e.spec.gapY,
                gapH: e.spec.gapH,
                passed: false,
            };
            return { ...s, pipes: [...s.pipes, p], spawned: s.spawned + 1 };
        }

        case "flap":
            // Randomised jump strength: set vy to provided value
            return { ...s, bird: { ...s.bird, vy: e.vy } };

        case "tick": {
            const dt = e.dt / 1000;
            // Record ghost sample for this run (pure append)
            const ghostNow = [...s.ghostNow, { t: s.t + e.dt, y: yClamped }];

            // Bird physics
            const vyNext = s.bird.vy + Physics.GRAVITY * dt;
            const yRaw = s.bird.y + vyNext * dt;
            const minY = Birb.HEIGHT / 2;
            const maxY = Viewport.CANVAS_HEIGHT - Birb.HEIGHT / 2;
            const yClamped = clamp(yRaw, minY, maxY);

            // Move pipes & cull offscreen
            const moved = s.pipes.map(p => ({
                ...p,
                x: p.x - Physics.PIPE_SPEED * dt,
            }));
            const visible = moved.filter(p => p.x + Constants.PIPE_WIDTH > 0);

            // Scoring
            const birdX = Viewport.CANVAS_WIDTH * 0.3;
            let score = s.score;
            const pipes = visible.map(p => {
                if (!p.passed && p.x + Constants.PIPE_WIDTH < birdX) {
                    score += 1;
                    return { ...p, passed: true };
                }
                return p;
            });

            // Collisions (with pipes OR boundaries) + directional bounces
            const firstHitPipe = pipes.find(p =>
                collides({ y: yClamped, vy: vyNext }, p),
            );
            const hitPipe = !!firstHitPipe;

            // Edge hits
            const hitTopEdge = yRaw <= minY;
            const hitBottomEdge = yRaw >= maxY;

            // Pipe half: compare bird centre to the pipe gap centre
            const hitTopPipe = !!firstHitPipe && s.bird.y <= firstHitPipe.gapY;
            const hitBottomPipe =
                !!firstHitPipe && s.bird.y > firstHitPipe.gapY;

            const hit = hitPipe || hitTopEdge || hitBottomEdge;

            // Invulnerability countdown
            const nextIFrames = Math.max(0, s.iFramesMs - e.dt);

            let lives = s.lives;
            let vyAfter = vyNext;
            let iFramesMs = nextIFrames;

            if (hit && nextIFrames === 0) {
                // lose a life and bounce in the required direction
                lives = Math.max(0, s.lives - 1);

                // random magnitude helper
                const rand = (lo: number, hi: number) =>
                    lo + Math.random() * (hi - lo);

                if (hitTopEdge || hitTopPipe) {
                    // spec: “bounce DOWN” on top hits ⇒ positive vy
                    vyAfter = rand(250, 300);
                } else if (hitBottomEdge || hitBottomPipe) {
                    // spec: “bounce UP” on bottom hits ⇒ negative vy
                    vyAfter = -rand(300, 500);
                }

                iFramesMs = LivesCfg.HIT_COOLDOWN_MS;
            }

            const allSpawned = s.spawned >= s.totalToSpawn;
            const cleared = pipes.length === 0 && allSpawned;
            const gameEnd = lives <= 0 || cleared;

            return {
                ...s,
                t: s.t + e.dt,
                bird: { y: yClamped, vy: vyAfter },
                pipes,
                score,
                lives,
                gameEnd,
                iFramesMs,
                ghostNow,
            };
        }
    }
};

/** ───────────── CSV parsing ─────────────
 * Expects: gap_y,gap_height,time with gap_* in [0,1] and time in seconds.
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

/** ───────────── state$ — build one run from CSV ───────────── */
export const state$ = (csvContents: string): Observable<State> => {
    // Key stream: Space for flap (prevent page scroll)
    const key$ = fromEvent<KeyboardEvent>(window, "keydown");
    const fromKey = (keyCode: Key) =>
        key$.pipe(
            filter(
                e =>
                    e.code === keyCode ||
                    (keyCode === "Space" &&
                        (e.key === " " || e.code === "Space")),
            ),
            tap(e => {
                if (e.code === "Space" || e.key === " ") e.preventDefault();
            }),
        );

    // Randomised jump strength from your dot logic
    const space$ = fromKey("Space");
    const jumpStrength$ = createRngStreamFromSource(space$)(Constants.SEED);
    const flap$: Observable<EvFlap> = jumpStrength$.pipe(
        map(rand => {
            const vy = -450 + rand * 120; // tune as you like
            return { kind: "flap", vy } as const;
        }),
    );

    /** Determines the rate of time steps */
    const tick$ = interval(Constants.TICK_RATE_MS).pipe(
        map((): EvTick => ({ kind: "tick", dt: Constants.TICK_RATE_MS })),
    );

    // Parse CSV & schedule pipe spawns
    const specs = parseCsv(csvContents);
    const spawn$ = merge(
        ...specs.map((spec, id) =>
            timer(spec.timeMs).pipe(
                map((): EvSpawn => ({ kind: "spawn", id, spec })),
            ),
        ),
    );

    const init: State = {
        ...initialState,
        totalToSpawn: specs.length,
        ghostNow: [],
        ghostPrev: ghostPrev ?? undefined,
    };

    // Reduce all events into State and complete on game end
    const events$: Observable<Event> = merge(tick$, flap$, spawn$);
    return events$.pipe(
        scan(step, init),
        startWith(init),
        takeWhile(s => !s.gameEnd, true),
    );
};

// The following simply runs your main function on window load.  Make sure to leave it in place.
// You should not need to change this, beware if you are.
if (typeof window !== "undefined") {
    const { protocol, hostname, port } = new URL(import.meta.url);
    const baseUrl = `${protocol}//${hostname}${port ? `:${port}` : ""}`;
    const csvUrl = `${baseUrl}/assets/map.csv`;

    // Get the file from URL
    const csv$ = fromFetch(csvUrl).pipe(
        switchMap(response => {
            if (response.ok) {
                return response.text();
            } else {
                throw new Error(`Fetch error: ${response.status}`);
            }
        }),
        catchError(err => {
            console.error("Error fetching the CSV file:", err);
            // tiny fallback so the game still runs
            return of(
                "gap_y,gap_height,time\n0.5,0.25,1\n0.6,0.23,3\n0.4,0.22,5",
            );
        }),
    );

    // First click to start (and ensure focus so key events are captured)
    const click$ = fromEvent(document.body, "mousedown").pipe(
        take(1),
        tap(() => (document.body as HTMLElement).focus()),
    );

    // Press 'R' to restart
    const restart$ = fromEvent<KeyboardEvent>(window, "keydown").pipe(
        filter(e => e.code === "KeyR"),
    );

    // Start on first click, then every time 'R' is pressed we switch to a fresh run.
    csv$.pipe(
        switchMap(contents =>
            click$.pipe(
                switchMap(() =>
                    restart$.pipe(
                        startWith(null), // run immediately after the first click
                        switchMap(() => state$(contents)), // NEW run each time (fresh timers, lives reset)
                    ),
                ),
            ),
        ),
    ).subscribe(render());
}
