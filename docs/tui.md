# TUI

Customize Xal's terminal interface, keyboard shortcuts, transcript details, and terminal notifications.

## Display preferences

Run `/config` in the TUI to change display preferences. Changes save immediately to the user configuration and apply to the current transcript. `scrollbackRows` is edited in the configuration file rather than through `/config`.

| Option           | Type      | Default | Description                                                                  |
| ---------------- | --------- | ------- | ---------------------------------------------------------------------------- |
| `showOutputs`    | `boolean` | `false` | Expand tool outputs and other transcript details.                            |
| `showThinking`   | `boolean` | `false` | Include model reasoning in the transcript.                                   |
| `scrollbackRows` | `number`  | `1000`  | Rows of transcript rebuilt into terminal scrollback. `0` disables the limit. |

These values live under `pluginConfig.tui`:

```json
{
  "pluginConfig": {
    "tui": {
      "showOutputs": false,
      "showThinking": false,
      "scrollbackRows": 1000
    }
  }
}
```

## Transcript rebuilds

The terminal owns wrapping for rows Xal has already written, so a terminal that changes width leaves the transcript above wrapped for the old one. Xal rebuilds instead: on a width change it clears its scrollback and re-prints the transcript from the session's own blocks at the new width, after the resize has been quiet for a moment. Resuming a session prints the same rebuilt transcript.

`scrollbackRows` bounds that rebuild. Xal prints the most recent rows up to the limit and marks the top of the transcript when anything was left out, so rebuild cost stays flat as a session grows. Set it near what your terminal actually retains — rows beyond that are dropped by the terminal anyway. Set it to `0` to rebuild the whole transcript every time, which is exact but grows more expensive the longer a session runs.

The `display.toggle-details` shortcut, Ctrl+O by default, temporarily toggles transcript details for the current session without changing `showOutputs`. Normal mode keeps task dispatches compact and shows completed background work as its ID plus the first report line. Expanded mode adds assignment metadata, status and line counts, spawned-agent details, and report output. Context compaction appears in the transcript as soon as it starts, followed by the completed compaction summary. Task plans are optional and created at the model's discretion for non-trivial, multi-phase work. Xal does not inject reminders to create or update a plan. A fully completed plan is dismissed when the session returns to idle, while plans with pending or in-progress work remain visible.

## Keybindings

Application shortcuts can be replaced under `pluginConfig.tui.keybindings`. Each action accepts an ordered array of bindings. The array replaces that action's defaults, and an empty array disables the action. Restart Xal after changing keybindings.

```json
{
  "pluginConfig": {
    "tui": {
      "keybindings": {
        "composer.external-editor": ["ctrl+e"],
        "display.clear": ["ctrl+l", "ctrl+k"],
        "display.toggle-todos": [],
        "agents.stop-all": ["ctrl+x ctrl+s"]
      }
    }
  }
}
```

A binding is a key with optional `ctrl`, `alt`, `shift`, or `super` modifiers joined by `+`. Separate strokes with a space to form a sequence. `control`, `meta`, `option`, `cmd`, and `command` are accepted aliases. Key and modifier names are case-insensitive.

| Action                     | Default bindings                     |
| -------------------------- | ------------------------------------ |
| `agents.open`              | `ctrl+x ctrl+a`                      |
| `agents.stop-all`          | `ctrl+x ctrl+k`                      |
| `app.cancel`               | `ctrl+c`                             |
| `composer.clear`           | `ctrl+u`                             |
| `composer.external-editor` | `ctrl+g`                             |
| `composer.newline`         | `shift+enter`, `alt+enter`, `ctrl+j` |
| `composer.paste-image`     | `ctrl+v`                             |
| `display.clear`            | `ctrl+l`                             |
| `display.toggle-details`   | `ctrl+o`                             |
| `display.toggle-todos`     | `ctrl+t`                             |
| `history.open`             | `escape escape`, `ctrl+r`            |
| `jobs.background`          | `ctrl+b`                             |
| `session.next-mode`        | `shift+tab`                          |
| `thinking.decrease`        | `alt+,`                              |
| `thinking.increase`        | `alt+.`                              |

`display.clear` removes the visible transcript and pre-launch terminal scrollback while keeping Xal's startup header, active session, and composer draft.

Malformed bindings, unknown actions, duplicate assignments, and bindings that are prefixes of other bindings fail startup. Popover navigation, completion selection, task-list navigation, and ordinary text editing remain component-owned and are not remapped by this setting.

## Terminal notifications

The TUI always emits OSC 9;4 progress while Xal is working and an OSC 777 notification when a turn completes, fails, or is interrupted. Notifications include the trailing 200 characters of visible assistant output, are not gated by terminal focus, and use tmux passthrough automatically. OSC lifecycle signaling is built in and has no configuration.
