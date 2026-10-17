# TypingWPM

TypingWPM is a Vencord userplugin that shows your live typing speed above the Discord message box.

It displays a compact WPM badge while you type, using Discord/Vencord theme tokens so it fits cleanly with the chat UI.

## Features

- Live words-per-minute calculation while typing in the main chat input
- Compact pill positioned above the message box, coloured by pace, with a gauge bar that fills toward 160 WPM
- Pace states: idle, warming up (<50), steady (50-90), fast (90-130), and blazing (130+)
- Tooltip with the current typing pace and exact WPM
- Persistent average WPM tracker in plugin settings (covers the last 35 days)
- Estimated accuracy and a keybr-style keyboard map in plugin settings: keys are coloured from least to most accurate, with the best and worst key outlined
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

## Accuracy

Discord has no reference text to compare against, so accuracy is an **estimate**: a key counts as an error when you delete it with Backspace (Ctrl+Backspace deletes a word; Alt/Meta+Backspace is not tracked). Accuracy is the share of keys you kept. Keys corrected up to about 50 keys after being tallied still count against the right key and the day they were typed.

- Keystrokes are only buffered while you type; the maths runs afterwards, when you pause for 15 seconds, send a message, buffer 500 keys, or the plugin stops.
- A key needs at least 20 presses before it is coloured and ranked.
- Limits: deleting text you meant to reword counts as an error, and uncorrected typos do not. Paste, caret movement, IME composition and edits made elsewhere in the draft are not tracked, and the keyboard map is a US-QWERTY layout (other characters still count toward overall accuracy).
- Privacy: only per-day, per-character `[presses, errors]` counts are stored, with no order, so text cannot be rebuilt from them. Up to ~500 recent keys, plus a 50-key tail of the current draft, are held in memory in typed order (cleared when you press Enter, switch editor, or use navigation keys and shortcuts; sending with the button or Escape does not clear it) and are never stored in order.

## Installation

Place the plugin folder in:

```text
src/userplugins/TypingWPM
```

Then rebuild or reload Vencord and enable `TypingWPM` in your plugins list.

## Notes

- The plugin counts typing in message composers (including thread and edit boxes).
- Modifier shortcuts such as `Ctrl`, `Alt`, and `Meta` combinations are ignored.
- The badge is shown only in the main chat input.
