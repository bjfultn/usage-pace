# usage-pace

A Claude Code mod that shows your plan's usage limits as compact bars above the prompt: the 5-hour session limit, the weekly limit, and any model-specific weekly limit (such as Fable), all on one line.

Each bar has a pacing caret above it marking where usage would be if you were exactly on pace. The bar is coloured by how your usage is pacing:

| Colour | Meaning |
| --- | --- |
| Blue | plenty of headroom |
| Green | on pace |
| Yellow | a little hot |
| Orange | running hot |
| Red | will run out early |

After each bar comes the percentage used, then the time until that window resets (`↻2h30`). If you are on track to hit the limit before then, it shows the time until you hit it instead (`⚠38m`).

The desktop app, VS Code and the mobile app draw thin SVG bars. The terminal draws a glyph bar, with `╋` marking pace.

Run `/usage-pace` for a detailed breakdown of each limit: pace, projected use at reset, and when it resets.

## Install

At the prompt of a terminal Claude Code session:

```
/plugin install usage-pace --marketplace bjfultn/usage-pace
```

Answer `y` to add the marketplace, then pick a scope (user scope loads it in every session).

From a shell:

```bash
claude plugin install usage-pace --marketplace bjfultn/usage-pace
```

In the desktop app: click **+** next to the prompt box, then **Plugins**, then **Add marketplace** with `bjfultn/usage-pace`, then **Add plugin**.

## Where the numbers come from

- The 5-hour and weekly readings come from what Claude Code already reports about rate limits, plus the rate-limit headers on its API responses.
- Model-specific limits (such as Fable) come from the same plan-usage endpoint that the usage page reads. The mod checks it every few minutes using the session's own sign-in. This works only for subscription (claude.ai) sign-ins, not API keys.

Nothing is sent anywhere else. The last readings are kept in the plugin's local store, so the bars show right away when a session starts.
