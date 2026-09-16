# Scrapemint — working rules

## Everything gets committed and pushed

Work is not done when it runs. It is done when it is committed and pushed to
`origin/main`. Finish every task by committing the change and pushing it, in the
same session that made it — do not leave a dirty working tree behind, and do not
wait to be asked.

This applies to actor source, `.actor/actor.json`, READMEs, pricing files,
tooling and docs. If a task produced a file, that file is either committed or
deliberately deleted before the session ends.

### The one carve-out: this repo is public

`github.com/Ken-Mutisya/scrapemint` is a **public** repository. These paths are
gitignored on purpose and must stay that way:

- `.env` — live `APIFY_TOKEN`, `APIFY_PROXY_PASSWORD` and Upwork credentials
- `automation/`, `logs/`, `content/`, `PLAYBOOK.md` — promotion machinery,
  account tactics and post logs

"Commit everything" means everything tracked. Never push a secret to satisfy it.
If work lands in `automation/` it is still real work — say so explicitly at the
end of the task, so it is a known trade-off rather than a silent gap.

## Apify platform facts worth not relearning

- The store page renders `<title>` from `seoTitle or title` plus a ` · Apify`
  suffix, and `<meta name="description">` from `seoDescription or description`
  **hard-cut at 152 characters**. Keep `seoTitle` <= 52 and `seoDescription`
  <= 152. `automation/deploy-seo.mjs` enforces both.
- `categories` in `actor.json` only apply at actor creation. Editing that field
  on an existing actor does nothing; use `PUT /v2/acts/{id}`, then update the
  local file so it does not drift.
- Apify runs the **build**, not the source. A pushed fix is not live until a
  build succeeds after it.
- Before "fixing" a stale build, read the commit message and any runbook. Some
  holds are deliberate — see `automation/OCT-1-RUNBOOK.md`, where code must not
  ship before the pricing text that announces it.
