/*
 * Vencord, a Discord client mod
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./styles.css";

import { ChatBarButtonFactory } from "@api/ChatButtons";
import * as DataStore from "@api/DataStore";
import { definePluginSettings } from "@api/Settings";
import definePlugin, { IconComponent, OptionType } from "@utils/types";
import { Button, Forms, React, ReactDOM, Tooltip } from "@webpack/common";

const settings = definePluginSettings({
    windowSeconds: {
        type: OptionType.NUMBER,
        description: "Rolling window in seconds for WPM calculation (longer = smoother)",
        default: 8,
        restartNeeded: false,
    },
    showWhenIdle: {
        type: OptionType.BOOLEAN,
        description: "Keep the badge visible when you are not actively typing",
        default: false,
        restartNeeded: false,
    },
});

const WPMEvents = (() => {
    const listeners: Record<string, Array<() => void>> = {};

    return {
        on(evt: string, fn: () => void) {
            (listeners[evt] ??= []).push(fn);
        },
        off(evt: string, fn: () => void) {
            listeners[evt] = (listeners[evt] ?? []).filter(f => f !== fn);
        },
        emit(evt: string) {
            (listeners[evt] ?? []).forEach(fn => fn());
        },
    };
})();

interface BadgePos {
    top: number;
    right: number;
}

type KeyTally = [total: number, errors: number];

interface DayStats {
    date: string;
    totalWpm: number;
    samples: number;
    bestWpm: number;
    keys?: Record<string, KeyTally>;
}

interface WPMStats {
    days: Record<string, DayStats>;
    totalWpm: number;
    samples: number;
    bestWpm: number;
    keyTotal: number;
    keyErrors: number;
    updatedAt: number;
}

interface HeatmapDay {
    date: string;
    averageWpm: number;
    bestWpm: number;
    samples: number;
}

let charTimestamps: number[] = [];
let idleTimer: ReturnType<typeof setTimeout> | null = null;
let portalRoot: HTMLDivElement | null = null;
let statsSaveTimer: ReturnType<typeof setTimeout> | null = null;
let lastSampleAt = 0;
let statsCache = createEmptyStats();
// Accuracy is tallied after the fact: keydown only appends to these arrays, flushPending() does the maths.
let pendingKeys: string[] = [];
let pendingErrors: string[] = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let counted: Array<[key: string, date: string]> = []; // tail of already-tallied keys of the current draft, so later corrections still blame the right key
let lateErrors: Array<[key: string, date: string]> = [];
let lastTarget: EventTarget | null = null;
let loaded = false; // nothing is recorded or saved until saved history has been read
let loadGen = 0;
let loading: Promise<void> | null = null;
let loadingGen = -1;

const BADGE_W = 136;
const BADGE_H = 36;
const BADGE_GAP = 8;
const HEATMAP_DAYS = 35;
const PAUSE_MS = 2000; // gaps longer than this are thinking time, not typing time
const MIN_KEYS = 5;
const MIN_ACTIVE_MS = 1500;
const ACTIVE_SAMPLE_MS = 1200; // only sample while the last key was this recent
const GAUGE_MAX_WPM = 160;
const SAMPLE_INTERVAL_MS = 2000;
const STATS_SAVE_DEBOUNCE_MS = 1000;
const STATS_KEY = "TypingWPM_stats_v1";
const FLUSH_IDLE_MS = 15_000;
const MAX_PENDING = 500;
const COUNTED_TAIL = 50;
const MIN_KEY_SAMPLES = 20; // keys with fewer presses are shown grey and never ranked

function createEmptyStats(): WPMStats {
    return {
        days: {},
        totalWpm: 0,
        samples: 0,
        bestWpm: 0,
        keyTotal: 0,
        keyErrors: 0,
        updatedAt: 0,
    };
}

function getDay(date: string): DayStats {
    return statsCache.days[date] ??= { date, totalWpm: 0, samples: 0, bestWpm: 0 };
}

function getDateKey(timestamp = Date.now()): string {
    const date = new Date(timestamp);
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");

    return `${year}-${month}-${day}`;
}

function getAverageWpm(totalWpm: number, samples: number): number {
    if (samples === 0) return 0;
    return Math.round(totalWpm / samples);
}

function cloneStats(stats: WPMStats): WPMStats {
    return {
        ...stats,
        days: Object.fromEntries(
            Object.entries(stats.days).map(([date, day]) => [date, { ...day, keys: day.keys && { ...day.keys } }])
        ),
    };
}

function updateStatsSummary(stats: WPMStats): WPMStats {
    const days = Object.values(stats.days);

    stats.totalWpm = days.reduce((total, day) => total + day.totalWpm, 0);
    stats.samples = days.reduce((total, day) => total + day.samples, 0);
    stats.bestWpm = days.reduce((best, day) => Math.max(best, day.bestWpm), 0);
    stats.keyTotal = 0;
    stats.keyErrors = 0;
    for (const day of days) {
        for (const [total, errors] of Object.values(day.keys ?? {})) {
            stats.keyTotal += total;
            stats.keyErrors += errors;
        }
    }

    return stats;
}

function trimStats(stats: WPMStats): WPMStats {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - (HEATMAP_DAYS - 1));
    const cutoff = getDateKey(cutoffDate.getTime());

    for (const date of Object.keys(stats.days)) {
        if (date < cutoff) delete stats.days[date];
    }

    return updateStatsSummary(stats);
}

function normaliseStats(rawStats: WPMStats | undefined): WPMStats {
    if (!rawStats?.days) return createEmptyStats();

    const stats = createEmptyStats();

    for (const [date, rawDay] of Object.entries(rawStats.days)) {
        if (!rawDay || !/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;

        const samples = Number(rawDay.samples) || 0;
        const totalWpm = Number(rawDay.totalWpm) || 0;
        const bestWpm = Number(rawDay.bestWpm) || 0;

        const keys: Record<string, KeyTally> = {};
        for (const [key, tally] of Object.entries(rawDay.keys ?? {})) {
            const total = Number(tally?.[0]);
            const errors = Number(tally?.[1]);
            if (key && total > 0 && errors >= 0 && errors <= total) keys[key] = [total, errors];
        }

        const hasKeys = Object.keys(keys).length > 0;
        if ((samples <= 0 || totalWpm <= 0) && !hasKeys) continue;

        stats.days[date] = {
            date,
            totalWpm,
            samples,
            bestWpm,
            ...(hasKeys && { keys }),
        };
    }

    stats.updatedAt = Number(rawStats.updatedAt) || 0;
    return trimStats(stats);
}

function loadStats(): Promise<void> {
    if (loaded) return Promise.resolve();
    if (loading && loadingGen === loadGen) return loading;

    const gen = loadGen;
    loadingGen = gen;
    let mine!: Promise<void>; // assigned below; the async body only reads it after its first await
    mine = loading = (async () => {
        try {
            const saved = normaliseStats(await DataStore.get<WPMStats>(STATS_KEY));
            if (gen !== loadGen) return; // reset/stop happened mid-read; don't resurrect old data

            statsCache = saved;
            loaded = true;
            WPMEvents.emit("statsUpdate");
            flushPending();
        } catch (err) {
            // stay unloaded so a failed read can never be followed by a save that wipes history
            console.error("[TypingWPM] failed to load stats", err);
        } finally {
            if (loading === mine) loading = null;
        }
    })();
    return mine;
}

function saveStatsNow() {
    if (statsSaveTimer) {
        clearTimeout(statsSaveTimer);
        statsSaveTimer = null;
    }

    if (!loaded) return Promise.resolve();
    return DataStore.set(STATS_KEY, statsCache).catch(err => console.error("[TypingWPM] failed to save stats", err));
}

function scheduleStatsSave() {
    if (statsSaveTimer) return;

    statsSaveTimer = setTimeout(() => {
        statsSaveTimer = null;
        void saveStatsNow();
    }, STATS_SAVE_DEBOUNCE_MS);
}

function recordWpmSample(wpm: number) {
    const sample = Math.round(wpm);
    const now = Date.now();

    if (!loaded || !Number.isFinite(sample) || sample <= 0 || !isActivelyTyping()) return;
    if (now - lastSampleAt < SAMPLE_INTERVAL_MS) return;

    lastSampleAt = now;

    const date = getDateKey(now);
    const day = getDay(date);

    day.totalWpm += sample;
    day.samples++;
    day.bestWpm = Math.max(day.bestWpm, sample);

    statsCache.updatedAt = now;
    statsCache = trimStats(statsCache);

    WPMEvents.emit("statsUpdate");
    scheduleStatsSave();
}

// Folds the buffered keystrokes into today's per-key tallies. A key later removed with Backspace counts as an error.
function flushPending() {
    if (flushTimer) {
        clearTimeout(flushTimer);
        flushTimer = null;
    }
    if (!loaded) return; // buffers are kept and flushed once history has loaded
    if (!pendingKeys.length && !pendingErrors.length && !lateErrors.length) return;

    const now = Date.now();
    const keys = (getDay(getDateKey(now)).keys ??= {});
    const add = (key: string, errors: number) => {
        if (key === "\n") return;
        const [total, wrong] = keys[key] ?? [0, 0];
        keys[key] = [total + 1, wrong + errors];
    };

    pendingKeys.forEach(key => add(key, 0));
    pendingErrors.forEach(key => add(key, 1));
    for (const [key, date] of lateErrors) {
        const tally = statsCache.days[date]?.keys?.[key]; // day may have been trimmed away
        if (tally) tally[1] = Math.min(tally[0], tally[1] + 1);
    }

    const today = getDateKey(now);
    counted = [...counted, ...pendingKeys.map((k): [string, string] => [k, today])].slice(-COUNTED_TAIL);
    pendingKeys = [];
    pendingErrors = [];
    lateErrors = [];

    statsCache.updatedAt = now;
    statsCache = trimStats(statsCache);
    WPMEvents.emit("statsUpdate");
    scheduleStatsSave();
}

function scheduleFlush() {
    if (flushTimer) clearTimeout(flushTimer);
    flushTimer = setTimeout(flushPending, FLUSH_IDLE_MS);
}

// Draft ended or became untrackable (sent, caret moved, other editor): bank what we have and forget the tail.
function resetDraft() {
    flushPending();
    counted = [];
}

// shortcut: assumes the caret is at the end of the draft, so mid-text edits and pastes are not tracked; upgrade by diffing the composer text.
function recordBackspace(wholeWord: boolean) {
    const last = () => pendingKeys.length ? pendingKeys[pendingKeys.length - 1] : counted[counted.length - 1]?.[0];
    const eraseOne = () => {
        const key = pendingKeys.pop();
        if (key !== undefined) return void pendingErrors.push(key);
        const old = counted.pop();
        if (old !== undefined) lateErrors.push(old);
    };

    if (!wholeWord) return eraseOne();

    while (last() === " ") eraseOne();
    while (last() !== undefined && last() !== " ") eraseOne();
}

async function resetStats() {
    pendingKeys = [];
    pendingErrors = [];
    lateErrors = [];
    counted = [];
    loadGen++;
    loaded = true;
    statsCache = createEmptyStats();
    lastSampleAt = 0;
    await saveStatsNow();
    WPMEvents.emit("statsUpdate");
}

function getWindowMs(): number {
    const seconds = Number(settings.store.windowSeconds);
    return (Number.isFinite(seconds) && seconds >= 3 ? seconds : 8) * 1000;
}

// Speed over time actually spent typing: pauses and trailing idle time don't drag the score down.
function calcWPM(): number {
    const now = Date.now();
    const windowMs = getWindowMs();

    charTimestamps = charTimestamps.filter(t => now - t <= windowMs);
    if (charTimestamps.length < MIN_KEYS) return 0;

    let activeMs = 0;
    let activeIntervals = 0;
    for (let i = 1; i < charTimestamps.length; i++) {
        const gap = charTimestamps[i] - charTimestamps[i - 1];
        if (gap <= PAUSE_MS) {
            activeMs += gap;
            activeIntervals++; // keys after a pause count only for the time they actually took
        }
    }
    if (activeMs < MIN_ACTIVE_MS) return 0;

    return Math.round((activeIntervals / 5) / (activeMs / 60_000));
}

function isActivelyTyping(): boolean {
    const last = charTimestamps[charTimestamps.length - 1];
    return last !== undefined && Date.now() - last <= ACTIVE_SAMPLE_MS;
}

function getOrCreatePortalRoot(): HTMLDivElement {
    if (!portalRoot) {
        portalRoot = document.createElement("div");
        portalRoot.id = "vc-wpm-portal";

        const appMount = document.getElementById("app-mount") ?? document.body;
        appMount.appendChild(portalRoot);
    }

    return portalRoot;
}

function removePortalRoot() {
    portalRoot?.remove();
    portalRoot = null;
}

function measurePos(): BadgePos | null {
    const textbox = document.querySelector(
        "form [data-slate-editor=\"true\"], form [role=\"textbox\"][aria-multiline=\"true\"], form textarea"
    ) as HTMLElement | null;
    if (!textbox) return null;

    const form = textbox.closest("form") as HTMLElement | null;
    if (!form) return null;

    const r = form.getBoundingClientRect();
    return {
        top: Math.max(BADGE_GAP, Math.round(r.top - BADGE_H - BADGE_GAP)),
        right: Math.max(BADGE_GAP, Math.round(window.innerWidth - r.right + BADGE_GAP)),
    };
}

function getPace(wpm: number) {
    if (wpm === 0) return {
        className: "is-idle",
        label: "Idle",
    };

    if (wpm < 50) return {
        className: "is-building",
        label: "Warming up",
    };

    if (wpm < 90) return {
        className: "is-steady",
        label: "Steady pace",
    };

    if (wpm < 130) return {
        className: "is-fast",
        label: "Fast pace",
    };

    return {
        className: "is-blazing",
        label: "Blazing",
    };
}

function WPMWidget() {
    const { showWhenIdle: keepVisibleSetting } = settings.use(["showWhenIdle"]);
    const showWhenIdle = !!keepVisibleSetting;
    const [wpm, setWpm] = React.useState(0);
    const [visible, setVisible] = React.useState(() => showWhenIdle);
    const [pos, setPos] = React.useState<BadgePos | null>(null);

    function refresh() {
        const measuredPos = measurePos();
        if (measuredPos) setPos(measuredPos);
    }

    React.useEffect(() => {
        refresh();

        const observer = new ResizeObserver(refresh);
        observer.observe(document.documentElement);

        window.addEventListener("resize", refresh);
        window.addEventListener("scroll", refresh, true);

        return () => {
            observer.disconnect();
            window.removeEventListener("resize", refresh);
            window.removeEventListener("scroll", refresh, true);
        };
    }, []);

    React.useEffect(() => {
        if (showWhenIdle) {
            setVisible(true);
        } else if (wpm === 0 && charTimestamps.length === 0) {
            setVisible(false);
        }
    }, [showWhenIdle, wpm]);

    React.useEffect(() => {
        if (!visible && !showWhenIdle) return;

        const interval = setInterval(() => {
            const currentWpm = calcWPM();
            setWpm(currentWpm);
            recordWpmSample(currentWpm);
        }, 500);

        return () => clearInterval(interval);
    }, [showWhenIdle, visible]);

    React.useEffect(() => {
        function onKeystroke() {
            const currentWpm = calcWPM();

            refresh();
            setWpm(currentWpm);
            setVisible(true);
            recordWpmSample(currentWpm);

            if (idleTimer) clearTimeout(idleTimer);
            idleTimer = setTimeout(() => {
                charTimestamps = [];
                setWpm(0);
                if (!showWhenIdle) setVisible(false);
            }, getWindowMs() + 300);
        }

        WPMEvents.on("keystroke", onKeystroke);
        return () => WPMEvents.off("keystroke", onKeystroke);
    }, [showWhenIdle]);

    if (!visible || !pos) return null;

    const pace = getPace(wpm);
    const tooltip = `${pace.label} - ${wpm} words per minute`;

    return (
        <Tooltip text={tooltip}>
            {({ onMouseEnter, onMouseLeave }) => ReactDOM.createPortal(
                <div
                    className={`vc-typing-wpm-pill ${pace.className}`}
                    onMouseEnter={onMouseEnter}
                    onMouseLeave={onMouseLeave}
                    style={{
                        top: pos.top,
                        right: pos.right,
                        width: BADGE_W,
                        height: BADGE_H,
                    }}
                >
                    <span className="vc-typing-wpm-dot" />
                    <span className="vc-typing-wpm-value">{wpm}</span>
                    <span className="vc-typing-wpm-label">WPM</span>
                    <span
                        className="vc-typing-wpm-gauge"
                        style={{ width: `${Math.min(100, (wpm / GAUGE_MAX_WPM) * 100)}%` }}
                    />
                </div>,
                getOrCreatePortalRoot()
            )}
        </Tooltip>
    );
}

function getHeatmapDays(stats: WPMStats): HeatmapDay[] {
    const today = new Date();
    const days: HeatmapDay[] = [];

    for (let i = HEATMAP_DAYS - 1; i >= 0; i--) {
        const date = new Date(today);
        date.setDate(today.getDate() - i);

        const dateKey = getDateKey(date.getTime());
        const day = stats.days[dateKey];

        days.push({
            date: dateKey,
            averageWpm: day ? getAverageWpm(day.totalWpm, day.samples) : 0,
            bestWpm: day?.bestWpm ?? 0,
            samples: day?.samples ?? 0,
        });
    }

    return days;
}

function getHeatLevel(averageWpm: number): number {
    if (averageWpm === 0) return 0;
    if (averageWpm < 50) return 1;
    if (averageWpm < 90) return 2;
    if (averageWpm < 130) return 3;
    return 4;
}

function formatDate(dateKey: string): string {
    return new Date(`${dateKey}T00:00:00`).toLocaleDateString(undefined, {
        month: "short",
        day: "numeric",
    });
}

function useWPMStats(): WPMStats {
    const [stats, setStats] = React.useState(() => cloneStats(statsCache));

    React.useEffect(() => {
        void loadStats();

        const onStatsUpdate = () => setStats(cloneStats(statsCache));

        WPMEvents.on("statsUpdate", onStatsUpdate);
        return () => {
            WPMEvents.off("statsUpdate", onStatsUpdate);
        };
    }, []);

    return stats;
}

function getAccuracy(total: number, errors: number): number | null {
    if (total === 0) return null;
    return Math.round((1 - errors / total) * 1000) / 10;
}

const KEY_ROWS = [
    { keys: "1234567890-=", offset: 0 },
    { keys: "qwertyuiop[]", offset: 0.5 },
    { keys: "asdfghjkl;'", offset: 0.75 },
    { keys: "zxcvbnm,./", offset: 1.25 },
];

function AccuracyKeyboard({ stats }: { stats: WPMStats; }) {
    const tallies: Record<string, KeyTally> = {};
    for (const day of Object.values(stats.days)) {
        for (const [key, [total, errors]] of Object.entries(day.keys ?? {})) {
            const t = tallies[key] ??= [0, 0];
            t[0] += total;
            t[1] += errors;
        }
    }

    const shown = ["space", ...KEY_ROWS.flatMap(row => [...row.keys])];
    const accuracyOf = (key: string) => {
        const [total, errors] = tallies[key === "space" ? " " : key] ?? [0, 0];
        return { total, accuracy: total >= MIN_KEY_SAMPLES ? 1 - errors / total : null };
    };

    const ranked = shown
        .map(key => ({ key, ...accuracyOf(key) }))
        .filter((k): k is { key: string; total: number; accuracy: number; } => k.accuracy !== null)
        .sort((a, b) => b.accuracy - a.accuracy);
    const best = ranked[0];
    const worst = ranked.length > 1 && ranked[0].accuracy !== ranked[ranked.length - 1].accuracy ? ranked[ranked.length - 1] : undefined;
    const spread = best && worst ? Math.max(best.accuracy - worst.accuracy, 0.02) : 1;

    const renderKey = (id: string) => {
        const { total, accuracy } = accuracyOf(id);
        const label = id === "space" ? "Space" : id.toUpperCase();
        const tip = accuracy === null
            ? `${label} - ${total}/${MIN_KEY_SAMPLES} presses needed`
            : `${label} - ${(accuracy * 100).toFixed(1)}% accurate over ${total} presses`;
        const hue = accuracy === null ? 0 : !worst ? 120 : Math.round(((accuracy - worst.accuracy) / spread) * 120);
        const mark = accuracy === null || !worst ? "" : id === best?.key ? " is-best" : id === worst.key ? " is-worst" : "";

        return (
            <Tooltip key={id} text={tip}>
                {({ onMouseEnter, onMouseLeave }) => (
                    <div
                        role="img"
                        className={`vc-typing-wpm-key${accuracy === null ? " is-unknown" : ""}${mark}${id === "space" ? " is-space" : ""}`}
                        style={{ "--wpm-hue": hue } as React.CSSProperties}
                        onMouseEnter={onMouseEnter}
                        onMouseLeave={onMouseLeave}
                        aria-label={tip}
                    >
                        {id === "space" ? "" : label}
                    </div>
                )}
            </Tooltip>
        );
    };

    return (
        <div className="vc-typing-wpm-keyboard-wrap">
            <div className="vc-typing-wpm-heatmap-header">
                <Forms.FormTitle tag="h4">Key Accuracy</Forms.FormTitle>
                <Forms.FormText>
                    {best && worst
                        ? `Best ${best.key === "space" ? "Space" : best.key.toUpperCase()} ${(best.accuracy * 100).toFixed(1)}% · Worst ${worst.key === "space" ? "Space" : worst.key.toUpperCase()} ${(worst.accuracy * 100).toFixed(1)}%`
                        : ranked.length > 1 ? "All ranked keys are tied so far" : `Type ${MIN_KEY_SAMPLES}+ presses on a few keys to rank them`}
                </Forms.FormText>
            </div>
            <div className="vc-typing-wpm-keyboard">
                {KEY_ROWS.map(row => (
                    <div key={row.keys} className="vc-typing-wpm-key-row" style={{ marginLeft: `calc(${row.offset} * (var(--wpm-key) + 4px))` }}>
                        {[...row.keys].map(renderKey)}
                    </div>
                ))}
                <div className="vc-typing-wpm-key-row" style={{ marginLeft: `calc(3.5 * (var(--wpm-key) + 4px))` }}>
                    {renderKey("space")}
                </div>
            </div>
        </div>
    );
}

function StatBlock({ label, value, suffix, accent }: { label: string; value: number | string; suffix?: string; accent?: string; }) {
    return (
        <div className={`vc-typing-wpm-stat ${accent ? "accent-" + accent : ""}`}>
            <span className="vc-typing-wpm-stat-label">{label}</span>
            <span className="vc-typing-wpm-stat-value">
                {value}
                {suffix && <span>{suffix}</span>}
            </span>
        </div>
    );
}

function WPMStatsSettings() {
    const stats = useWPMStats();
    const heatmapDays = getHeatmapDays(stats);
    const today = stats.days[getDateKey()];
    const averageWpm = getAverageWpm(stats.totalWpm, stats.samples);
    const accuracy = getAccuracy(stats.keyTotal, stats.keyErrors);
    const todayAverageWpm = today ? getAverageWpm(today.totalWpm, today.samples) : 0;

    return (
        <div className="vc-typing-wpm-settings">
            <Forms.FormTitle tag="h3">Typing Stats</Forms.FormTitle>

            <div className="vc-typing-wpm-stat-grid">
                <StatBlock label="Average" value={averageWpm} suffix=" WPM" accent="steady" />
                <StatBlock label="Today" value={todayAverageWpm} suffix=" WPM" accent="building" />
                <StatBlock label="Best" value={stats.bestWpm} suffix=" WPM" accent="fast" />
                <StatBlock label="Est. Accuracy" value={accuracy ?? "—"} suffix={accuracy === null ? undefined : "%"} accent="accuracy" />
                <StatBlock label="Samples" value={stats.samples} />
            </div>

            <div className="vc-typing-wpm-heatmap-header">
                <Forms.FormTitle tag="h4">Last 35 Days</Forms.FormTitle>
                <Forms.FormText>{stats.samples === 0 ? "No typing samples yet" : `${stats.samples} tracked samples`}</Forms.FormText>
            </div>

            <div className="vc-typing-wpm-heatmap" role="img" aria-label="Typing WPM heatmap for the last 35 days">
                {heatmapDays.map(day => {
                    const averageText = day.samples === 0 ? "No samples" : `${day.averageWpm} average WPM, ${day.bestWpm} best WPM`;

                    return (
                        <Tooltip key={day.date} text={`${formatDate(day.date)} - ${averageText}`}>
                            {({ onMouseEnter, onMouseLeave }) => (
                                <div
                                    className={`vc-typing-wpm-heatmap-cell level-${getHeatLevel(day.averageWpm)}`}
                                    onMouseEnter={onMouseEnter}
                                    onMouseLeave={onMouseLeave}
                                    aria-label={`${formatDate(day.date)}: ${averageText}`}
                                />
                            )}
                        </Tooltip>
                    );
                })}
            </div>

            <div className="vc-typing-wpm-legend" aria-hidden="true">
                <span>Slower</span>
                {[0, 1, 2, 3, 4].map(l => <i key={l} className={`vc-typing-wpm-heatmap-cell level-${l}`} />)}
                <span>Faster</span>
            </div>

            <AccuracyKeyboard stats={stats} />

            <Button
                className="vc-typing-wpm-reset"
                color={Button.Colors.RED}
                size={Button.Sizes.SMALL}
                onClick={() => void resetStats()}
            >
                Reset Stats
            </Button>
        </div>
    );
}

const TypingWPMIcon: IconComponent = ({ height = 20, width = 20, className }) => (
    <svg
        aria-hidden="true"
        role="img"
        width={width}
        height={height}
        className={className}
        viewBox="0 0 24 24"
    >
        <path fill="currentColor" d="M4 18a8 8 0 1 1 16 0h-2a6 6 0 1 0-12 0H4Zm4.46-1.1 5.22-7.46 1.64 1.14-5.22 7.46-1.64-1.14ZM7 19h10v2H7v-2Z" />
    </svg>
);

const WPMChatBarButton: ChatBarButtonFactory = ({ isMainChat }) => {
    if (!isMainChat) return null;
    return <WPMWidget />;
};

const PRINTABLE_RE = /^.$/u;
const NAV_KEYS = new Set(["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End", "PageUp", "PageDown", "Delete"]);

function handleKeyDown(e: KeyboardEvent) {
    const target = e.target as HTMLElement | null;
    if (!target) return;

    const inMessageBox =
        !!target.closest("[data-slate-editor=\"true\"]") ||
        target.tagName === "TEXTAREA" ||
        (
            target.getAttribute("role") === "textbox" &&
            target.getAttribute("aria-multiline") === "true"
        );

    if (!inMessageBox) return;
    if (!target.closest("form")) return;
    if (e.isComposing || e.keyCode === 229) return resetDraft(); // IME text can't be tracked, so stop attributing to earlier keys

    if (target !== lastTarget) {
        resetDraft();
        lastTarget = target;
    }

    // Until history has loaded nothing is buffered for accuracy (the draft is reset), but WPM timing below still runs.
    if (!loaded) resetDraft();

    if (e.key === "Backspace") {
        if (e.altKey || e.metaKey) return resetDraft(); // semantics differ per OS, so don't guess
        recordBackspace(e.ctrlKey);
        scheduleFlush();
        return;
    }
    if (e.key === "Enter") {
        if (e.shiftKey) { if (loaded) pendingKeys.push("\n"); } else resetDraft();
        return;
    }
    if (NAV_KEYS.has(e.key)) return resetDraft();

    const altGr = e.getModifierState?.("AltGraph");
    if (!altGr && (e.ctrlKey || e.altKey || e.metaKey)) {
        if (e.key.length === 1) resetDraft(); // e.g. Ctrl+V / Ctrl+Z change the draft invisibly
        return;
    }
    if (e.repeat || !PRINTABLE_RE.test(e.key)) return;

    const now = Date.now();
    if (loaded) {
        pendingKeys.push(e.key.toLowerCase());
        if (pendingKeys.length >= MAX_PENDING) flushPending(); else scheduleFlush();
    }

    charTimestamps.push(now);
    const cutoff = now - getWindowMs();
    while (charTimestamps.length && charTimestamps[0] < cutoff) charTimestamps.shift();
    WPMEvents.emit("keystroke");
}

export default definePlugin({
    name: "TypingWPM",
    description: "Shows a compact typing speed badge above the message box.",
    authors: [{ name: ".dean.", id: 285021062578700289n }],
    settings,
    settingsAboutComponent: WPMStatsSettings,
    chatBarButton: {
        icon: TypingWPMIcon,
        render: WPMChatBarButton,
    },

    start() {
        void loadStats();
        document.addEventListener("keydown", handleKeyDown, true);
    },

    stop() {
        document.removeEventListener("keydown", handleKeyDown, true);
        removePortalRoot();
        charTimestamps = [];

        if (idleTimer) {
            clearTimeout(idleTimer);
            idleTimer = null;
        }

        flushPending();
        void saveStatsNow();
        loaded = false;
        loadGen++;
        pendingKeys = [];
        pendingErrors = [];
        lateErrors = [];
        counted = [];
        lastTarget = null;
    },
});
