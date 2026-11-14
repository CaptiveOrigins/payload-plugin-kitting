# First public push audit

By the Kitting Plugin session, 2026-11-09, at commit 5b09d2d (Release 0.2.0), with the repo still private. Making it public is the owner's step.

Why now: npm accepts provenance only from public repositories. Release run https://github.com/ExtantApe/payload-plugin-kitting/actions/runs/42703638071 failed at staging with "Only public source repositories are supported when publishing with provenance". Nothing was staged or published.

All 36 commits on every branch were scanned, not just the latest files.

| Check | Result |
| --- | --- |
| `scripts/leak-check.sh` locally, with the private terms list | passed |
| Private terms anywhere in history, commit messages included | none (one random package-lock checksum is allow-listed, see `scripts/leak-allow.txt`) |
| Keys and tokens (Stripe, EasyPost, AWS, GitHub, npm, Slack, private keys, Mongo URLs with a password, hard-coded passwords or secrets) | none |
| Email addresses in history | only made-up `@example.com` addresses in tests, the noreply author address, and GitHub's own address on merge commits |
| IP addresses, server or database hosts, deploy URLs | none |
| Phone numbers, street addresses | none |
| Real supplier, customer or kit data | none. Tests use made-up supplies, suppliers and IDs |
| Home folder paths, personal names | none. Git's author field holds the full name, which is allowed |
| Claude session links in commit text | none |
| Build output, packed files, `.env`, `.secrets/` | never committed |
| Leak check in CI | yes, the first step of `.github/workflows/ci.yml` |
| LICENSE | MIT, now "Copyright (c) 2026 EXTANT APE", in the npm package |
| README status line | yes |

Result: clean. Nothing needed rewriting.
