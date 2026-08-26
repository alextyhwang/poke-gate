# Installing Agents

You can download community agents from the Poke Gate repository with a single command.

## Install an agent

```bash
npx poke-gate agent get <name>
```

For example:

```bash
npx poke-gate agent get beeper
```

This does three things:

1. **Downloads the agent script** from GitHub to `~/.config/poke-gate/agents/`
2. **Downloads the env template** (if one exists)
3. **Prompts you to fill in env variables** interactively

## Interactive env setup

If the agent needs secrets, you'll be prompted:

```
Fetching agent "beeper" from GitHub...
  Saved: ~/.config/poke-gate/agents/beeper.1h.js

  This agent needs 1 env variable(s):

  BEEPER_TOKEN (Find it in Beeper Desktop > Settings > API): █

  Saved: ~/.config/poke-gate/agents/.env.beeper

  Test it: npx poke-gate run-agent beeper
```

The prompt parses the `.env` template, identifies placeholder values, and asks you for real ones. Comments from the template are shown as hints.

## Test after installing

Always test the agent before relying on it:

```bash
npx poke-gate run-agent beeper
```

## Existing env files

If you already have a `.env.<name>` file, it won't be overwritten. You'll see:

```
.env.beeper already exists, skipped.
```

## Browse available agents

See all community agents at:

[github.com/alextyhwang/poke-gate/tree/main/examples/agents](https://github.com/alextyhwang/poke-gate/tree/main/examples/agents)

## Install via macOS app

You can also manage agents through the macOS app's **Agents** window — browse, edit, and create agents with a built-in syntax-highlighted editor.
