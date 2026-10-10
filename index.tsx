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

interface DayStats {
    date: string;
    totalWpm: number;
    samples: number;
    bestWpm: number;
}

interface WPMStats {
    days: Record<string, DayStats>;
    totalWpm: number;
    samples: number;
    bestWpm: number;
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

const BADGE_W = 136;
const BADGE_H = 36;
const BADGE_GAP = 8;
const HEATMAP_DAYS = 35;
const PAUSE_MS = 2000; // gaps longer than this are thinking time, not typing time
const MIN_KEYS = 5;
const MIN_ACTIVE_MS = 1500;
const ACTIVE_SAMPLE_MS = 1200; // only sample while the last key was this recent
const GAUGE_MAX_WPM = 120;
const SAMPLE_INTERVAL_MS = 2000;
const STATS_SAVE_DEBOUNCE_MS = 1000;
const STATS_KEY = "TypingWPM_stats_v1";

function createEmptyStats(): WPMStats {
    return {
        days: {},
        totalWpm: 0,
        samples: 0,
        bestWpm: 0,
        updatedAt: 0,
    };
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
            Object.entries(stats.days).map(([date, day]) => [date, { ...day }])
        ),
    };
}

function updateStatsSummary(stats: WPMStats): WPMStats {
    const days = Object.values(stats.days);

    stats.totalWpm = days.reduce((total, day) => total + day.totalWpm, 0);
    stats.samples = days.reduce((total, day) => total + day.samples, 0);
    stats.bestWpm = days.reduce((best, day) => Math.max(best, day.bestWpm), 0);

    return stats;
}

function trimStats(stats: WPMStats): WPMStats {
    const dates = Object.keys(stats.days).sort();
    const staleDates = dates.slice(0, Math.max(0, dates.length - HEATMAP_DAYS));

    for (const date of staleDates) {
        delete stats.days[date];
    }

    return updateStatsSummary(stats);
}

function normaliseStats(rawStats: WPMStats | undefined): WPMStats {
    if (!rawStats?.days) return createEmptyStats();

    const stats = createEmptyStats();

    for (const [date, rawDay] of Object.entries(rawStats.days)) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;

        const samples = Number(rawDay.samples) || 0;
        const totalWpm = Number(rawDay.totalWpm) || 0;
        const bestWpm = Number(rawDay.bestWpm) || 0;
        if (samples <= 0 || totalWpm <= 0) continue;

        stats.days[date] = {
            date,
            totalWpm,
            samples,
            bestWpm,
        };
    }

    stats.updatedAt = Number(rawStats.updatedAt) || 0;
    return trimStats(stats);
}

async function loadStats() {
    const savedStats = normaliseStats(await DataStore.get<WPMStats>(STATS_KEY));

    if (savedStats.updatedAt >= statsCache.updatedAt) {
        statsCache = savedStats;
        WPMEvents.emit("statsUpdate");
    }
}

function saveStatsNow() {
    if (statsSaveTimer) {
        clearTimeout(statsSaveTimer);
        statsSaveTimer = null;
    }

    return DataStore.set(STATS_KEY, statsCache);
}

function scheduleStatsSave() {
    if (statsSaveTimer) return;

    statsSaveTimer = setTimeout(() => {
        statsSaveTimer = null;
        void DataStore.set(STATS_KEY, statsCache);
    }, STATS_SAVE_DEBOUNCE_MS);
}

function recordWpmSample(wpm: number) {
    const sample = Math.round(wpm);
    const now = Date.now();

    if (!Number.isFinite(sample) || sample <= 0 || !isActivelyTyping()) return;
    if (now - lastSampleAt < SAMPLE_INTERVAL_MS) return;

    lastSampleAt = now;

    const date = getDateKey(now);
    const day = statsCache.days[date] ??= {
        date,
        totalWpm: 0,
        samples: 0,
        bestWpm: 0,
    };

    day.totalWpm += sample;
    day.samples++;
    day.bestWpm = Math.max(day.bestWpm, sample);

    statsCache.updatedAt = now;
    statsCache = trimStats(statsCache);

    WPMEvents.emit("statsUpdate");
    scheduleStatsSave();
}

async function resetStats() {
    statsCache = createEmptyStats();
    lastSampleAt = 0;
    await saveStatsNow();
    WPMEvents.emit("statsUpdate");
}

function getWindowMs(): number {
    return ((settings.store.windowSeconds as number | undefined) ?? 5) * 1000;
}

// Speed over time actually spent typing: pauses and trailing idle time don't drag the score down.
function calcWPM(): number {
    const now = Date.now();
    const windowMs = getWindowMs();

    charTimestamps = charTimestamps.filter(t => now - t <= windowMs);
    if (charTimestamps.length < MIN_KEYS) return 0;

    let activeMs = 0;
    for (let i = 1; i < charTimestamps.length; i++) {
        const gap = charTimestamps[i] - charTimestamps[i - 1];
        if (gap <= PAUSE_MS) activeMs += gap;
    }
    if (activeMs < MIN_ACTIVE_MS) return 0;

    // n keystrokes span n-1 intervals
    return Math.round(((charTimestamps.length - 1) / 5) / (activeMs / 60_000));
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

    if (wpm < 30) return {
        className: "is-building",
        label: "Warming up",
    };

    if (wpm < 60) return {
        className: "is-steady",
        label: "Steady pace",
    };

    if (wpm < 90) return {
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
    if (averageWpm < 35) return 1;
    if (averageWpm < 60) return 2;
    if (averageWpm < 85) return 3;
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
        let mounted = true;

        DataStore.get<WPMStats>(STATS_KEY).then(rawStats => {
            if (!mounted) return;

            const savedStats = normaliseStats(rawStats);
            if (savedStats.updatedAt > statsCache.updatedAt) {
                statsCache = savedStats;
            }

            setStats(cloneStats(statsCache));
        });

        const onStatsUpdate = () => setStats(cloneStats(statsCache));

        WPMEvents.on("statsUpdate", onStatsUpdate);
        return () => {
            mounted = false;
            WPMEvents.off("statsUpdate", onStatsUpdate);
        };
    }, []);

    return stats;
}

function StatBlock({ label, value, suffix, accent }: { label: string; value: number; suffix?: string; accent?: string; }) {
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
    const todayAverageWpm = today ? getAverageWpm(today.totalWpm, today.samples) : 0;

    return (
        <div className="vc-typing-wpm-settings">
            <Forms.FormTitle tag="h3">Typing Stats</Forms.FormTitle>

            <div className="vc-typing-wpm-stat-grid">
                <StatBlock label="Average" value={averageWpm} suffix=" WPM" accent="steady" />
                <StatBlock label="Today" value={todayAverageWpm} suffix=" WPM" accent="building" />
                <StatBlock label="Best" value={stats.bestWpm} suffix=" WPM" accent="fast" />
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
    if (e.ctrlKey || e.altKey || e.metaKey || e.repeat) return;
    if (!PRINTABLE_RE.test(e.key)) return;

    charTimestamps.push(Date.now());
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

        void saveStatsNow();
    },
});
