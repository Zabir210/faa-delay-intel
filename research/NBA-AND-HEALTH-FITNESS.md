# NBA and health/fitness: where the seams actually are

Companion to `ADJACENT-OPPORTUNITIES.md`, September 2026. Same screening
lens: ephemerality, decay rate, named budget holder, competitive vacancy,
solo buildability.

Headline conclusions, stated up front so the rest can be skimmed:

- **Consumer fitness apps are the single worst market in this document.**
  Don't. Reasons in §2.1.
- **The best health opportunity is not fitness at all** — it's longitudinal
  evidence of health-plan provider directory contents, which just acquired a
  regulatory forcing function (§2.2).
- **The best NBA opportunity is archival, not analytical.** Every predictive
  angle is crowded by better-capitalized operators. The thing nobody owns is
  a timestamped record of what was published and when (§1.2).
- **NBA has a lower ceiling but a two-week path to owning it.** Health has a
  far higher ceiling and a six-month path with legal exposure. Pick
  deliberately; they are not the same kind of bet.

---

## 1. NBA

### 1.1 The domain reality: NBA data is closing, not opening

This is the most important fact and it inverts the usual assumption.

- NBA.com **publishes no changelog** for its public backend. Endpoints are
  added, changed, and removed silently; the main open-source client
  (`swar/nba_api`) relies on users reporting deprecations via GitHub issues
  after they break.
- Access is actively hardened: Cloudflare rate limiting, IP bans, browser
  fingerprinting, requests from anything but a real Chrome browser refused,
  some endpoints region-locked.
- Location-based **shot data has been quietly rolled back** from public
  access, moved behind partnerships and paywalls, to stop third-party
  resellers monetizing it.

So the ephemerality here is *doubled*: both the data and the **right to
retrieve it** decay. Anything you can pull today may be unavailable next
season, and there is no announcement when it goes.

Two consequences:

1. **The capture-now thesis is stronger here than for the FAA feed**, which
   at least is a stable public-service endpoint the FAA has no incentive to
   close. The NBA has an active commercial incentive to close.
2. **Scraping posture is a real risk, not a footnote.** Fingerprinting and
   IP bans mean your pipeline's reliability guarantees — the thing your
   `ingest_runs` design is built around — are adversarial here, not merely
   flaky. Budget for it or pick a source that is published as a document
   rather than served by an API (see below — this is why the injury report
   PDF is the right target).

### 1.2 Tier 1 — the injury report *transition ledger*

**Not the injury list. The transitions, and their timestamps.**

Teams must designate a participation status by **5:00 p.m. local time the
day before** a game, then update it. The official PDFs carry both a
**Current Status** and a **Previous Status** column — the league itself
models this as a state machine. Statuses move Probable → Questionable →
Out, and the *timing* of that move is where the information is.

**Ephemerality: high, and confirmed.** The official 2026-27 injury report
page currently 404s; the prior season's page returns 200 but exposes no
timestamped PDF links. Historical PDFs exist at stable CDN paths
(`ak-static.cms.nba.com/referee/injury/Injury-Report_YYYY-MM-DD_HHPM.pdf`)
and are parseable — but they are not indexed, not linked, and not
guaranteed. Nobody is obliged to keep them and the league has no reason to.

**What is not captured anywhere commercially:** when a status changed, how
many minutes before tip-off, which team, which player tier, and how that
differs by team and by day of week. RotoWire, ESPN, CBS and
Basketball-Reference all publish **current** injury status. They do not
publish a queryable history of *transitions with timestamps*.

**Why the timing is the product:**
- Late flips are the mechanism behind usage-rate shocks. Search literature
  converges on the same point — when a starter is ruled out, the backup's
  rebound and minutes props lag the adjustment. The edge isn't knowing who
  is out; it's knowing *how late this team historically rules people out*,
  because that tells you how long the stale line persists.
- Teams have persistent behavioural fingerprints in how aggressively they
  use "Questionable" and how close to tip they resolve it. That is a
  measurable, per-team, per-season statistic that nobody publishes.
- It is directly auditable against the Player Participation Policy, which
  makes it interesting to media and league-accountability writers as well
  as bettors.

**Competitive read — honest.** There is prior art, all hobby-grade:
`mxufc29/nbainjuries` (a Python package for historical + real-time injury
report ETL), `buffedlizard55-lab/NBAInjuryReport`, and an Apify PDF
extractor. None of these is a maintained longitudinal dataset with
guaranteed capture and none sells transition analytics. That's an
opening, but it also means the technical approach is already public — your
moat is *uninterrupted capture starting now*, exactly as with the FAA feed.
It is not a technology moat and you should not pretend it is.

**Fit to your existing code:** extremely high, possibly higher than the drug
shortage case. A player/game/status tuple appearing and disappearing across
timestamped snapshots is precisely what `detect/events.py` already does, and
the PDF publication schedule (fixed times, multiple updates per day) maps
onto your polling model without modification. `MISSING_TOLERANCE` transfers
directly.

**Buyer set — and this is the weakness.** Sharp bettors and DFS players
(numerous, but cheap and churny), betting-content sites needing a data
hook, and possibly a book's trading desk. This is a **low four figures
MRR** business realistically, not a data-licensing business. Say that
plainly before spending two weeks on it.

### 1.3 Tier 3 — NBA angles that are already taken

Do not spend a weekend rediscovering these:

- **Referee assignment tendencies.** Assignments post ~9:00 a.m. ET on
  game day. Fully served: RefMetrics, Covers, OddsShark, DonaghyEffect all
  publish per-referee O/U and ATS splits. Saturated.
- **Player prop models.** Crowded with funded operators (Action Network,
  BettingPros, RotoWire, DraftEdge) and the consensus view is that the real
  remaining edge lives in **spatiotemporal tracking data at 25 fps** — which
  is exactly the data the NBA has been pulling back behind partnerships. You
  cannot get the input.
- **Box scores, standings, basic stats.** Commodity, many free APIs.

---

## 2. Health and fitness

### 2.1 Consumer fitness apps: the numbers say don't

Stating this bluntly because it is the obvious idea and it is a trap.

- Subscription churn rose from **8.2%/month in 2023 to 11.7%/month in
  2025** (Sensor Tower). Independent benchmarks put 2026 at ~9.2%/month.
  At ~10% monthly churn your median subscriber is gone inside a year.
- The top stated cancellation reasons are **lost motivation (38%)**, cost
  consolidation, and data privacy — none of which a better feature set
  fixes.
- Market is described consistently as extremely saturated with rising CAC
  and pricing pressure, against incumbents (Strava, Whoop, Peloton, Apple
  Fitness) with distribution you cannot match.

The market is large and growing (~$12–15B, low-teens CAGR) and that is
exactly the problem: it is large enough to attract capital and the
incumbents are funded. A solo builder with no distribution advantage loses
here. The two repositioning vectors worth knowing about — alignment with
**GLP-1 therapy** and **employer-funded wellness benefits**, which move
these products from discretionary to reimbursed — are real, but both
require clinical or benefits-channel partnerships, which is a
relationships business, not a code business.

If you want a health-adjacent build, go to the data/compliance layer below.

### 2.2 Tier 1 — provider directory longitudinal evidence ("ghost networks")

**This is the highest-value opportunity in either document, including the
FAA-adjacent ones.**

**The problem.** Health plans publish provider directories that are
substantially fictional, especially in behavioural health — listed
clinicians who have moved, retired, don't take the plan, or aren't
accepting patients. Patients relying on the directory get care they believe
is in-network and receive out-of-network bills, or give up on care entirely.

**The scale is documented, not anecdotal.** CMS's national review found
roughly **49% of provider locations in Medicare Advantage online
directories contained at least one inaccuracy**; at least 45% of listed
practice locations are simply wrong. A July 2025 national assessment found
only **two payers** reached 70% directory accuracy, with 35% of payers
stuck between 45% and 55% — essentially no improvement since CMS's 2018
audits.

**The forcing function arrived in 2026.** This is what makes it actionable
*now* rather than eventually:
- Congress passed a **directory-accuracy law**; new rules require ongoing
  verification, **secret-shopper audits**, and cost protections for patients
  when directories fail.
- Federal regulations now require states to run **annual secret shopper
  surveys** validating network status, address, phone, and whether the
  provider accepts new enrollees.
- The **American Psychiatric Association filed a class action in January
  2026** against an insurer over ghost networks.
- Georgia announced **$20M+ in fines against 22 insurers** in August 2025.
- Plaintiff firms are actively advertising ghost-network litigation.

**The ephemerality — and the actual product.** Provider directories are
**overwritten in place**. There is no version history. So when a patient,
a regulator, or a plaintiff's expert needs to establish *what the directory
said on the date the patient relied on it*, the evidence no longer exists.
Screenshots by individual patients are the current state of the art.

That is the gap. The product is not "measure directory accuracy." It is:

> A timestamped, immutable, per-plan, per-provider record of exactly what
> each directory published on every date, with diffs — so any past claim
> about a directory's contents can be evidenced rather than asserted.

Your architecture is a near-exact match: append-only raw layer (the
directory payload, stored verbatim), natural-key idempotent upsert
(plan + NPI + location + date), event derivation (provider appeared /
disappeared / phone changed / accepting-new-patients flipped), and
`ingest_runs` liveness — which here is not a nicety but an **evidentiary
requirement**, since a gap in capture is a gap in the record you'd have to
disclose.

**Competitive read — honest, and this is the crux.** Competitors exist:
Defacto Health (accuracy scoring), Atlas Systems / Periscope
(`pdichecker.com`, CMS attestation readiness), Myers & Stauffer
(secret-shopper surveys for states). **But they sell current-state
measurement** — call the office, confirm the listing, score the plan. Their
output is "your directory is 52% accurate today." None of them sells the
archive. The distinction matters commercially: measurement is a service
sold to the plan being measured; **evidence is sold to the plan's
adversaries** — plaintiff firms, state regulators, patient advocacy orgs,
and journalists. Different buyer, different sales motion, no direct
collision.

**Buyers, concretely:** plaintiff-side litigation firms building
ghost-network class actions (they pay for expert data and are already
spending on this), state insurance regulators and AGs running enforcement,
health policy researchers, and investigative journalists. Secondarily,
plans themselves — for defensive documentation of their own compliance
history.

**Why you could win it:** none of this requires medical knowledge, licensed
data, or clinical partnerships. It requires disciplined, uninterrupted,
timestamped capture with provable pipeline liveness — which is the one
thing this repo demonstrates you can do.

**Risks, stated honestly — read these before starting:**
1. **Collection difficulty.** Many directories are search-interface-driven,
   not downloadable files. Some plans do publish machine-readable provider
   directory files; start only with those. This is a scoping decision, not a
   blocker, but it determines feasibility — check it first.
2. **Terms of service and CFAA exposure.** Scraping payer sites at scale to
   build a product sold to those payers' litigation adversaries is a
   posture that attracts legal attention. **Get an opinion from a lawyer
   before you sell anything**, and prefer published machine-readable files
   over interface scraping wherever both exist.
3. **Evidentiary standards.** Data intended to support litigation needs
   chain-of-custody discipline — verbatim payload retention, hashes,
   complete capture logs. Your append-only + `ingest_runs` design already
   points this direction; formalize it deliberately rather than by accident.
4. **Sales cycle.** Law firms and state agencies are slow. This is not a
   two-week-to-first-dollar project.

**Narrow the beachhead.** Do not attempt "all payer directories." Start
with **behavioural health providers in one or two states with active
enforcement** (Georgia's fines and the APA suit indicate where attention
is). Behavioural health is where ghost networks are most prevalent and
where the litigation is concentrated.

### 2.3 Tier 2 — supplement formulation and allergen drift

**The gap is real but partially filled.** NIH's Dietary Supplement Label
Database (DSLD) holds 71,000+ labels with periodic updates, so basic label
data is public. The unaddressed part is **silent reformulation**: a
contract manufacturer swapping a capsule-shell supplier as a "like-for-like"
replacement can change the allergen profile with no announcement. Known
weak points cluster around **sesame** (added as a major allergen under the
FASTER Act in January 2023), **tree-nut specificity** (FDA expects the
individual nut named, not generic "tree nuts"), and cross-contact statements
inconsistent with a facility's actual controls.

**Product shape:** diff DSLD entries and retailer-published labels over
time; alert on ingredient/allergen changes for a watched product set.

**Buyer problem — the reason this is Tier 2.** The people who *care* most
(allergy-sensitive consumers, parents) won't pay meaningfully. The people
who *would* pay (brand QA teams, contract manufacturers, retailer
compliance) mostly have supplier attestations already. The honest bridge is
B2B monitoring for retailers and marketplaces carrying third-party
supplements, who bear recall and liability risk and have no systematic way
to detect a supplier's silent reformulation. Worth a week of validation
before more.

---

## 3. Recommendation

**If you want to ship something you own within a month: NBA injury
transition ledger (§1.2).** It is the cleanest possible port of this
repo's existing logic, the capture window is open right now, the prior art
is hobby-grade, and the NBA's pattern of silently closing endpoints means
the archive gets more valuable and harder to replicate every month you run
it. Accept that the realistic ceiling is a small subscription business.

**If you want the opportunity with a real ceiling: provider directory
evidence (§2.2).** Regulatory forcing function just landed, the
incumbents sell a different product to a different buyer, the buyers have
budgets and active litigation, and the technical requirement is precisely
the discipline you've already demonstrated. Accept a longer runway, a legal
consultation as a hard prerequisite, and real collection difficulty.

**Do both, sequenced, if you want the strongest position.** They are not
in tension:

1. **Week 1 — start NBA capture immediately.** The injury report PDFs are
   being published today and are not being archived by anyone with a
   guarantee. Poll, store raw PDFs verbatim, record `ingest_runs`. Do this
   before writing a parser. The season is running; every day you wait is a
   day of transitions you cannot recover.
2. **Week 1, in parallel — spend one day on directory feasibility.** Pick
   three plans in one state. Determine whether they publish machine-readable
   provider directory files or only search interfaces. That single answer
   decides whether §2.2 is a project or a fantasy, and it costs a day.
3. **Weeks 2–3 — port the event deriver to NBA transitions.** `status_events`
   with `player`, `team`, `game_date`, `from_status`, `to_status`,
   `changed_at`, `minutes_before_tipoff`. Publish one statistic nobody else
   has: median minutes-before-tip that each team resolves "Questionable."
   That's the entire pitch.
4. **Week 4+ — if directory feasibility came back positive, talk to a
   lawyer, then start capture on one state's behavioural health
   directories.** Capture is cheap; the product decision can come later,
   which is the whole advantage of an append-only design.

**The rule from the previous note still governs both.** Start ingesting
before you finish designing. In the NBA case the league is actively closing
doors, and in the directory case the evidentiary value of a snapshot is
strictly a function of how long ago you started taking them. Parsers are
recoverable. Uncaptured days are not.

---

## Sources

**NBA**
- [NBA Official Injury Report (2025-26)](https://official.nba.com/nba-injury-report-2025-26-season/) · [example historical PDF](https://ak-static.cms.nba.com/referee/injury/Injury-Report_2019-02-10_01PM.pdf)
- [mxufc29/nbainjuries](https://github.com/mxufc29/nbainjuries) · [buffedlizard55-lab/NBAInjuryReport](https://github.com/buffedlizard55-lab/NBAInjuryReport) · [Apify injury report PDF extractor](https://apify.com/zinin/sports-injury-report-pdf-extractor)
- [swar/nba_api](https://github.com/swar/nba_api) · [rate limit issue #650](https://github.com/swar/nba_api/issues/650) · [Brown VR wiki: NBA API troubleshooting & access restrictions](https://www.vrwiki.cs.brown.edu/applications-of-vr/vr-in-sports/troubleshooting-tips-for-nba-apiprivacy-laws-for-nba-api)
- Referee market (saturated): [RefMetrics](https://www.refmetrics.com/) · [Covers NBA referee stats](https://www.covers.com/sport/basketball/nba/referees) · [OddsShark referee handicapping](https://www.oddsshark.com/nba/referee-handicapping-statistics) · [DonaghyEffect](https://www.donaghyeffect.com/nba/referees/explained)
- Props/tracking-data edge: [Feature engineering for NBA player props](https://techbuzzireland.com/2026/02/02/beyond-the-box-score-feature-engineering-for-predictive-sports-models-focusing-on-nba-player-props-and-advanced-metrics/) · [Last Word: props market](https://lastwordonsports.com/basketball/2026/06/09/props-nba-betting-market/)

**Fitness app market**
- [RetentionCheck: fitness app churn benchmarks](https://retentioncheck.com/churn-benchmarks/fitness-apps) · [Grand View: fitness apps market](https://www.grandviewresearch.com/industry-analysis/fitness-app-market) · [Mordor: digital fitness apps](https://www.mordorintelligence.com/industry-reports/digital-fitness-apps-market) · [Chop Dawg: build a fitness app 2026](https://www.chopdawg.com/how-to-build-a-fitness-app-in-2026-wearable-integration-workout-tracking-and-user-retention/)

**Provider directories / ghost networks**
- [Defacto Health: National Provider Directory Accuracy, July 2025](https://defacto.health/2025/07/29/national-provider-directory-accuracy-july-2025-report/)
- [Acuity: Behavioral Health Ghost Networks 2026 — Lawsuits & Enforcement](https://acuity.news/regulation/behavioral-health-ghost-networks-2026-lawsuits-enforcement/) · [NBC News: ghost networks](https://www.nbcnews.com/health/health-care/ghost-networks-health-insurance-companies-therapy-rcna210591) · [Boston Globe opinion](https://www.bostonglobe.com/2026/05/17/opinion/ghost-networks-health-insurance-provider/) · [Petrie-Flom, Harvard Law](https://petrieflom.law.harvard.edu/2023/12/06/addressing-ghost-networks-in-mental-health-care/)
- [National Health Law Program: secret shopper surveys](https://healthlaw.org/secret-shopper-surveys-a-powerful-tool-for-directly-testing-medicaid-managed-care-enrollees-access-to-care/) · [Myers & Stauffer](https://myersandstauffer.com/what-we-do/managed-care-oversight-compliance/secret-shopper-surveys/) · [Periscope / pdichecker](https://pdichecker.com/) · [Atlas: directory validation companies](https://www.atlassystems.com/blog/provider-directory-validation-companies)
- Litigation posture: [The Lyon Firm](https://www.thelyonfirm.com/blog/ghost-network-lawsuits-health-insurance-directory-fraud) · [Wyden/Smith legislation](https://www.wyden.senate.gov/news/press-releases/wyden-smith-introduce-legislation-to-strengthen-mental-health-care-coverage-hold-insurance-companies-accountable)

**Supplements**
- [NIH Dietary Supplement Label Database](https://dsld.od.nih.gov/) · [DSLD: recent developments (PMC)](https://pmc.ncbi.nlm.nih.gov/articles/PMC6597011/) · [Challenges of label-derived supplement databases](https://www.sciencedirect.com/science/article/pii/S0022316622164151) · [Trustwell: allergen labeling on supplement panels](https://blog.trustwell.com/how-to-accurately-label-allergens-on-dietary-supplement-fact-panels) · [Ayah Labs: hidden allergens in botanicals](https://ayahlabs.com/blog/hidden-allergens-botanical-supplements-analytical-testing-labs-fsma/)
