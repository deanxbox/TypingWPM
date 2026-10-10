# TypingWPM

TypingWPM is a Vencord userplugin that shows your live typing speed above the Discord message box.

It displays a compact WPM badge while you type, using Discord/Vencord theme tokens so it fits cleanly with the chat UI.

## Features

- Live words-per-minute calculation while typing in the main chat input
- Compact pill positioned above the message box, coloured by pace, with a gauge bar that fills toward 120 WPM
- Pace states: idle, warming up (<30), steady (30-60), fast (60-90), and blazing (90+)
- Tooltip with the current typing pace and exact WPM
- Persistent average WPM tracker in plugin settings
- 35-day typing heatmap with daily average and best WPM tooltips, plus a slower-to-faster legend
- Optional idle visibility mode that keeps the badge visible at `0 WPM`
- Theme-aware styling with colour fallbacks so the value stays readable

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `windowSeconds` | `8` | Rolling time window, in seconds, used for the WPM calculation. |
| `showWhenIdle` | `false` | Keeps the badge visible when you are not actively typing. |

## How It Works

TypingWPM listens for printable key presses inside the Discord message composer, stores recent keystroke timestamps, and estimates WPM using the common `5 characters = 1 word` convention.

Only time spent actually typing counts: gaps longer than 2 seconds are treated as pauses and excluded, so thinking time and the idle tail after you stop do not drag the score down. A reading needs at least 5 keystrokes and 1.5 seconds of active typing, and held-down (auto-repeat) keys are ignored.

The badge automatically repositions when the window, scroll position, or chat layout changes.

Typing stats are stored locally through Vencord's DataStore. The plugin records non-zero WPM samples only while you are actively typing, then aggregates them by day for the settings heatmap.

## Installation

Place the plugin folder in:

```text
src/userplugins/TypingWPM
```

Then rebuild or reload Vencord and enable `TypingWPM` in your plugins list.

## Notes

- The plugin only counts typing in the message composer.
- Modifier shortcuts such as `Ctrl`, `Alt`, and `Meta` combinations are ignored.
- The badge is shown only in the main chat input.
