# TypingWPM

TypingWPM is a Vencord userplugin that shows your live typing speed above the Discord message box.

It displays a compact WPM badge while you type, using Discord/Vencord theme tokens so it fits cleanly with the chat UI.

## Features

- Live words-per-minute calculation while typing in the main chat input
- Compact badge positioned above the message box
- Pace indicator dot for idle, warming up, steady, and fast typing states
- Tooltip with the current typing pace and exact WPM
- Persistent average WPM tracker in plugin settings
- 35-day typing heatmap with daily average and best WPM tooltips
- Optional idle visibility mode that keeps the badge visible at `0 WPM`
- Theme-aware styling with a high-contrast WPM value

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `windowSeconds` | `5` | Rolling time window, in seconds, used for the WPM calculation. |
| `showWhenIdle` | `false` | Keeps the badge visible when you are not actively typing. |

## How It Works

TypingWPM listens for printable key presses inside the Discord message composer, stores recent keystroke timestamps, and estimates WPM using the common `5 characters = 1 word` convention.

The badge automatically repositions when the window, scroll position, or chat layout changes.

Typing stats are stored locally through Vencord's DataStore. The plugin records non-zero WPM samples while you type, then aggregates them by day for the settings heatmap.

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
