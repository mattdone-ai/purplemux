.PHONY: precommit acceptance-watch

precommit:
	pnpm lint
	pnpm tsc --noEmit
	pnpm exec vitest run --maxWorkers=4
	$(MAKE) acceptance-watch

# The deploy acceptance gate's watch checks (wave 3 of scripts/acceptance/checks.cjs) on this tree, the way
# deploy-live.sh runs the gate: a build, then run.sh against it in an isolated instance (PMUX-ACC-GRAPHQL: #85
# changed the watch reads, the unit suite stayed green, and the gate failed at deploy). About 3 min: the build
# about 1 min, the wave about 1.7 min. Every key that points a process at a live purplemux is unset first.
LIVE_KEYS := PMUX_URL PMUX_TOKEN PMUX_TAB_TOKEN PMUX_TAB_ID PMUX_WORKSPACE_ID PMUX_PORT TMUX TMUX_PANE CLAUDE_CONFIG_DIR GROK_HOME
ACCEPTANCE_WATCH_LOG ?= $(shell mktemp "$${TMPDIR:-/tmp}/acceptance-watch-XXXXXX.log")

acceptance-watch:
	env -u NODE_ENV pnpm build
	env $(addprefix -u ,$(LIVE_KEYS)) scripts/acceptance/run.sh --candidate "$(CURDIR)" --only-wave 3 --log "$(ACCEPTANCE_WATCH_LOG)"
