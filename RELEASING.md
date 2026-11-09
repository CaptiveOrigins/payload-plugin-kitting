# Releasing

`package.json` (`description`, `keywords`) is the single source for the description. GitHub's description and topics are copied from it with `npm run packages:sync` in the platform repo, and the Release workflow refuses to stage if GitHub differs.

1. Bump `version` in `package.json`, run `npm run packages:sync -- kitting` in the platform repo, commit as `Release x.y.z`, tag `vx.y.z`, and push the commit and the tag.
2. The Release workflow tests, builds and **stages** the version on npm (trusted publishing, no stored token).
3. The `captiveorigins` npm account approves it with 2FA: npmjs.com → avatar → **Staged Packages** → **Approve**, or `npm stage list` then `npm stage approve <id>`. Only then is it public.

The first version of a new package is published by hand by the owner (`npm publish --access public`), because npm can only trust a workflow for a package that exists. Then the owner runs `sh scripts/npm-trust.sh kitting` in the platform repo once.

Sessions never publish or approve.
