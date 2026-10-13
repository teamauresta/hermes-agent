# Install & Update E2E baselines

The owner-approved tracking policy for teamauresta/hermes-agent is genuine
published upstream stable releases → the tested fork commit. It is explicitly
scoped in .github/workflows/install-e2e.yml, not a fallback for all forks, and
never applies when inputs.release == true.

release-baselines.mjs pick reads the upstream GitHub release catalogue,
rejects drafts, prereleases and nonnumeric tags, and orders calendar and semver
releases by publication time. It fetches the published stable refs in one
request into refs/remotes/install-baselines/, not local or remote release
tags. Only strict ancestors of the tested HEAD are eligible: same-commit,
future and divergent baselines are reported and excluded. Oldest/newest/spread
sampling happens after these checks; absent compatible coverage fails the job.
An explicit --install-ref must also pass publication and ancestry checks.

The picker outputs the real release name, peeled immutable commit, source
repository and desktop capability. Matrix names retain release labels and
artifact IDs; drivers install the pinned commit. Every source driver first
runs prepare on a full checkout, fetching the exact commit and checking
strict ancestry again before making its bare source clone. HEAD → NEXT legs
remain the original synthetic-update tests; no published tags are minted.

Stable-release calls continue to require their own repository baseline tags
and the existing executed-source-matrix gate. The shell sampler supports
both numeric version schemes, using tag creation chronology rather than
numeric ordering across incompatible schemes.

Missing picker output is accepted only by the **results renderer**, which
reports that no installation/update legs executed. It does not make baseline
selection, installation tests or release gates succeed. Known historical
failure classification stays keyed by exact installed commit plus error/log
signatures, not tag membership alone. Tracker success is separate from
installation coverage.

## Verification

Run the dependency-free regression contracts:

    node --test scripts/sandbox/release-baselines.test.mjs tests/install/e2e-assets/release-plan.test.mjs

For a focused real source-upgrade run on every OS, dispatch the existing
workflow with route=installer-script -> hermes-update and tag-count=1.
This executes six source legs (one compatible upstream stable → HEAD and
HEAD → NEXT on each OS), not the full desktop/bundle or historical matrix.
Passing that subset must not be described as complete installation coverage.
Schedules, release tags and repository settings are unchanged by this repair.
