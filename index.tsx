/*
 * Vencord, a Discord client mod
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./styles.css";

import { ChatBarButtonFactory } from "@api/ChatButtons";
import { definePluginSettings } from "@api/Settings";
import definePlugin, { IconComponent, OptionType } from "@utils/types";
import { React, ReactDOM, Tooltip } from "@webpack/common";

const settings = definePluginSettings({
    windowSeconds: {
        type: OptionType.NUMBER,
        description: "Rolling window in seconds for WPM calculation",
        default: 5,
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

let charTimestamps: number[] = [];
let idleTimer: ReturnType<typeof setTimeout> | null = null;
let portalRoot: HTMLDivElement | null = null;

const BADGE_W = 120;
const BADGE_H = 34;
const BADGE_GAP = 8;

interface BadgePos {
    top: number;
    right: number;
}

function getWindowMs(): number {
    return ((settings.store.windowSeconds as number | undefined) ?? 5) * 1000;
}

function calcWPM(): number {
    const now = Date.now();
    const windowMs = getWindowMs();

    charTimestamps = charTimestamps.filter(t => now - t <= windowMs);
    if (charTimestamps.length < 2) return 0;

    const elapsedMs = Math.max(now - charTimestamps[0], 1000);
    return Math.round((charTimestamps.length / 5) / (elapsedMs / 60_000));
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

    if (wpm < 40) return {
        className: "is-building",
        label: "Warming up",
    };

    if (wpm < 80) return {
        className: "is-steady",
        label: "Steady pace",
    };

    return {
        className: "is-fast",
        label: "Fast pace",
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

        const interval = setInterval(() => setWpm(calcWPM()), 500);
        return () => clearInterval(interval);
    }, [showWhenIdle, visible]);

    React.useEffect(() => {
        function onKeystroke() {
            refresh();
            setWpm(calcWPM());
            setVisible(true);

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
                </div>,
                getOrCreatePortalRoot()
            )}
        </Tooltip>
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
    if (e.ctrlKey || e.altKey || e.metaKey) return;
    if (!PRINTABLE_RE.test(e.key)) return;

    charTimestamps.push(Date.now());
    WPMEvents.emit("keystroke");
}

export default definePlugin({
    name: "TypingWPM",
    description: "Shows a compact typing speed badge above the message box.",
    authors: [{ name: ".dean.", id: 285021062578700289n }],
    settings,
    chatBarButton: {
        icon: TypingWPMIcon,
        render: WPMChatBarButton,
    },

    start() {
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
    },
});
