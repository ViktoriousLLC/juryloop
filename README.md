# Juryloop

The problem today is that when Claude makes a plan, it only knows what it knows, and it cannot judge it, look at it from an objective third-party perspective and analyze it. Codex and Gemini have completely different brains and can critically give feedback. Many tools that do this are metered, where you pay per review. A few others also run on a plan (the Claude or ChatGPT subscription you already pay for), but of the ones I found, none run on their own: none review the plan automatically when it is written, and none stop the agent from merging until the work has been reviewed.

I built Juryloop, a Claude Code plugin that has other AI models review Claude's work using your current plan, and you don't have to pay for metered usage.

## How it works

1. **Install it and connect your accounts.** Paste this into Claude Code and open a new session:

   ```text
   /plugin install juryloop --marketplace ViktoriousLLC/juryloop
   ```

   Then connect ChatGPT (on your plan, through the Codex CLI, OpenAI's coding agent) and Gemini if you want it (on a Google AI Pro plan through the Antigravity CLI, Windows only for now, or metered on your own key). Other models are coming soon. Open an issue on this repo if you need one prioritized.

   Want to see it before connecting anything? `/juryloop:review demo` shows a full sample review. It calls no model, needs no login and saves nothing.

2. **Several models read the same work.** Opus reviews it on the Claude side, plus Fable if you turn it on, and the top two ChatGPT models, Sol and Astra, review it on the ChatGPT side. Each one reviews on its own, without seeing the others. You get one merged list of problems. A problem that models from two different companies both caught is listed first, and the problems only one model caught are listed separately. A review takes 1 to 3.5 minutes.

## What runs automatically

The whole point of building this was that every PR and every goal statement is automatically run through Juryloop.

- **Every goal statement.** When Claude writes a goal (the plan it works from on a bigger build), it gets reviewed before Claude can finish its reply.
- **Every pull request.** `gh pr merge` isn't allowed until the pull request has been reviewed.

It reruns up to 10 times. If the review finds problems, Claude fixes them and Juryloop runs again on the fixed version, so you don't have to keep sitting there asking it to review again and again. It stops the first time a round comes back with nothing to fix.

If a pull request is part of a goal, add a line like `Goal: docs/reference/goals/my-goal.md item 2` to its description. The reviewers then also check for work the goal asked for that is missing, and for changes nobody asked for.

You can also run it yourself on any file:

```text
/juryloop:review docs/plan.md
```

## Turning the automatic reviews off

Both automatic reviews are on when you install. If you'd rather it only runs when you type the command yourself, add this to `tribunal.config.json` in your repo:

```json
{ "gates": { "goalWall": false, "mergeGate": false } }
```

Settings, adding models and exit codes are all in [docs/REFERENCE.md](docs/REFERENCE.md).

## Coming from Tribunal Review

Juryloop used to be called Tribunal Review. Refresh the marketplace (`claude plugin marketplace update viktorious`), install `juryloop`, uninstall `tribunal-review`, and restart Claude Code so no open session keeps running the old version. If a repo turns the plugin on in its own `.claude/settings.json`, change `tribunal-review@viktorious` to `juryloop@viktorious` there too. Until you switch, the old plugin holds every merge and tells you how to switch, so nothing turns off quietly. Your settings file and review history keep working as they are.
