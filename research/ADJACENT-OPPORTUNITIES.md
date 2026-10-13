# Adjacent problems worth building

Research note, September 2026. Written against the capability actually
demonstrated by `faa-delay-intel`, not against a generic idea list.

---

## 1. What this repo actually proves you can do

The FAA tracker is not "an aviation project." Strip the domain and what
remains is a reusable pattern:

> A public authority publishes the **current state** of a system it operates.
> It never publishes the history. The moment the state changes, the previous
> state is gone forever. Capture it on a schedule, store it append-only,
> derive semantic events from the raw stream, and you own a dataset that
> cannot be recreated at any price.

The pieces you have already built and shipped:

| Piece | Where | Why it transfers |
|---|---|---|
| Scheduled fetch with retry + failure recording | `ingest/fetch.py`, `ingest_runs` | Every candidate below is a polled feed |
| Idempotent natural-key upsert | `db/schema.sql` `uq_observation_natural_key` | Re-polling is the normal case, not the error case |
| Append-only raw layer, never mutated | `observations` | Lets you rewrite the semantic layer later without data loss |
| Snapshot stream → events with start/peak/end | `detect/events.py` | The actual product. Raw snapshots are not saleable; *events* are |
| Absence tolerance (`MISSING_TOLERANCE = 2`) | `detect/events.py` | Every polled feed drops polls; naive logic fragments one event into six |
| Liveness separate from volume | `ingest_runs` + health banner | A quiet source and a dead scraper look identical without this |
| Reliable trigger off the critical path | `worker/src/index.ts` | You already learned GitHub Actions cron is best-effort |

That last row is the one most people get wrong, and you've already paid for
the lesson (commit `7663298`). **Every hour the pipeline isn't running is
history that cannot be recovered later** — your own words in `DEPLOY.md`.
That sentence is the whole thesis of this document.

---

## 2. The proof that this is a business, not a portfolio piece

**PowerOutage.us** is the same architecture, one domain over. It polls
~950 electric utility outage maps, aggregates, and publishes live status.
The author built it as a side project. In mid-2017 a telecom company asked
to buy access to the underlying data, and that request became the product.
It now sells a historical outage database at city-level precision and
10-minute resolution going back to 2016, plus custom CSV feeds.

Nothing about that story required capital, a team, or novel technology. It
required **starting the clock early and never stopping it**. The asset is
the elapsed time, and it compounds — a competitor starting today is
permanently nine years behind and cannot catch up by spending money.

Note the shape of the customer, too: not consumers looking at a map, but a
telecom that needed to correlate its own incidents against grid state. The
public-facing site was lead generation for a B2B data feed. That is the
model to plan for.

---

## 3. Screening criteria

Score a candidate on five axes. Anything scoring low on #1 or #2 is a
data-visualization project, not a data-*asset* project.

1. **Ephemerality** — is the prior state actually destroyed on update, or
   just inconvenient to find? If an archive exists, you are building a
   nicer UI on someone else's asset.
2. **Decay rate** — how fast does unobserved history become
   unreconstructable? Fast decay is *good*: it's the moat.
3. **Who bleeds money when it changes?** Name the budget holder. "Curious
   public" is not a budget holder. "Underwriter mispricing a policy" is.
4. **Competitive vacancy** — is the obvious incumbent free/public/generous,
   or enterprise-priced and slow? Enterprise-priced-and-slow is the seam.
5. **Solo buildability** — can one person capture it with a poller, a
   parser, and Postgres? Anything needing licensed data, credentials, or
   legal cover fails here.

---

## 4. Ranked candidates

### Tier 1 — build one of these

#### 4.1 FDA / ASHP drug shortages → shortage event history

**Ephemerality: very high.** This is the closest structural twin to your
FAA feed that exists. When a shortage resolves, FDA keeps the entry for
roughly six months and then **deletes it**. The database is a current-state
list, not a history, exactly like `nasstatus.faa.gov`.

**The tell:** peer-reviewed researchers studying shortage duration have
been reduced to scraping the **Internet Archive** — one study reconstructed
history from 39 Wayback captures of the FDA Excel file spanning 2019–2023;
another leaned on 476 Wayback snapshots from Jan 2023–Aug 2024. When
academics are mining the Wayback Machine to answer a basic question about a
federal dataset, the archival gap is real, documented, and citable.

**Who bleeds:** hospital pharmacy directors and GPO contract managers
(substitution planning, par-level changes), 503B outsourcing facilities and
generic manufacturers (entry timing — a shortage's typical duration decides
whether tooling up is profitable), health-system supply chain, and
pharmaceutical market analysts. Shortage *duration by molecule and
manufacturer* is a number people currently guess at.

**Product:** not "here's a shortage list" (FDA has one, openFDA exposes it).
The product is **resolved-shortage event records with real start, peak
severity, and end dates**, plus duration distributions by drug class, dosage
form, and reported cause. Your `delay_events` table maps onto this almost
field-for-field: `started_at` / `ended_at` / `peak` / `reason`.

**Why you specifically:** your event-derivation logic already solves the
hard part — turning a stream of "is it on the list right now" snapshots into
episodes with boundaries, tolerant of dropped polls. That is the entire
technical difficulty here.

**Caution:** openFDA does expose a drug shortages endpoint, so check its
retention behaviour before committing — if it retains resolved records
indefinitely, the gap narrows to ASHP's separate list and to
*severity/duration* enrichment rather than existence. Verify this in week
one; it is the single assumption the whole case rests on.

---

#### 4.2 FMCSA carrier safety scores → score trajectory history

**Ephemerality: high, and structurally guaranteed.** FMCSA's Safety
Measurement System recomputes every carrier's percentile rankings from a
**monthly snapshot** of the prior 24 months of roadside inspections and
crashes. Each month's snapshot *replaces* the last. A carrier's score
trajectory — the thing that predicts future loss — is not published. Worse,
percentiles are relative to a peer group that also moves, so a score can
change with no change in the carrier's own behaviour. Nobody can tell you
which happened without the snapshot series.

The category definitions themselves were just restructured (Vehicle
Maintenance split in two, Controlled Substances folded into Unsafe Driving),
which means anyone who *did* keep history now has a schema-migration
problem — and a fresh entrant capturing under the new scheme has a clean
series.

**Who bleeds:** commercial trucking insurance underwriters and MGAs
(scores directly drive premium), freight brokers and 3PLs (carrier
vetting and negligent-selection liability), shippers, and carriers
themselves contesting a score move they can't explain.

**Product:** per-DOT-number monthly score series; alerts on threshold
crossings and intervention-status changes; and the genuinely differentiated
piece — **decomposition of a percentile move into "you got worse" vs "your
peer group got better."** That analysis is impossible without the snapshot
series and valuable the moment you have twelve of them.

**Why it fits you:** monthly cadence means low infrastructure cost, and
missing a poll is catastrophic (a permanent hole in a 12-point-per-year
series) — which is exactly the failure mode your `ingest_runs` +
Cloudflare-Worker architecture was built to prevent. Data is public and
free.

**Caution:** the FMCSA snapshot files are large and the scoring methodology
is in flux under the CSA Prioritization Preview. Store raw, derive later —
which your architecture already mandates.

---

### Tier 2 — real, but enter with eyes open

#### 4.3 Payer medical policy & prior-authorization criteria changes

**The pain is enormous and well-documented:** when a payer quietly tightens
coverage criteria, denials spike weeks later and the provider finds out from
the AR aging report. Policy PDFs get revised in place.

**But the market is occupied and the archival gap is narrower than it
looks.** Policy Reporter (now Valeris) is the established incumbent;
DataRovers, Myndshft, MD Clarity and others crowd the adjacent space. And
several large payers do publish change control — Highmark issues monthly
medical policy update bulletins with **redlined additions in red and
deletions highlighted**; UnitedHealth/UMR publish dated policy update
bulletins with archives. So for the big nationals you'd be re-deriving
diffs that are already disclosed.

**Where the seam actually is:** regional Blues, Medicaid MCOs, and smaller
commercial plans — the ones with no bulletin discipline, whose PDFs change
silently. A specialty-scoped product ("every policy touching
infusion/ortho/behavioral health across the 40 plans that don't publish
redlines") is defensible where a horizontal one is not. Enterprise pricing
above you leaves room underneath for practice-management-sized customers.

**Verdict:** best revenue-per-customer of anything here, worst
build-to-first-dollar ratio. Viable if you pick one specialty and go deep;
a trap if you try to cover "payers."

---

#### 4.4 Hospital price transparency file drift

CMS-mandated machine-readable files exist and are public, but hospitals
overwrite them on update and CMS refines the required schema nearly
annually. Almost nobody keeps the **prior versions**, so rate *movement*
over time — which is what actually matters to a payer negotiating or an
employer benefits consultant — is invisible. Trilliant and others sell
current-state analytics on these files.

**Honest read:** the files are enormous (multi-GB per hospital), which is a
real infrastructure cost, and the space has funded competitors. The thin
wedge is *change detection*, not analytics: "these 14 CPT codes at this
system moved more than 10% against this payer since the last posting." That
is cheap to compute if you store hashes and deltas rather than full history,
and it's a different product from what the incumbents sell.

---

### Tier 3 — look attractive, are already served

Listed so you don't spend a weekend rediscovering this.

- **Grid interconnection queues.** Feels perfect — snapshot spreadsheets,
  high-stakes, developers desperate for queue intelligence. But
  **interconnection.fyi (GridTracker)** already compiles 50+ ISOs and
  utilities with daily updates and *gives it away free*, selling the
  complete dataset via Snowflake share; Grid Status and Pearl Street
  Technologies also cover it. The free tier is too good to undercut.
- **USCIS processing times.** Multiple free live trackers already exist, and
  USCIS itself publishes a historic processing times page. The complaint in
  the literature is *methodological inconsistency between USCIS's own
  pages*, not missing history — a different and much less tractable problem.
- **Utility power outages.** PowerOutage.us has ~950 utilities and history
  back to 2016. This is the proof case, not an opening.

---

## 5. Recommendation

**Build 4.1 (drug shortages) and run it on the same infrastructure as the
FAA tracker.**

Reasons, in order:

1. **Highest structural similarity** — it is a current-state feed with
   deletion-on-resolution, which is the exact problem `detect/events.py`
   already solves. You are porting, not inventing.
2. **The archival gap is independently documented.** You do not have to
   argue that history is missing; published research demonstrates it by
   resorting to the Wayback Machine.
3. **Named budget holders exist** in hospital pharmacy, GPOs, and generic
   manufacturing — and drug shortages get congressional attention in a way
   that keeps the topic funded.
4. **Marginal cost is near zero.** Same Neon instance (separate schema),
   same Worker cron, same test harness, same dashboard shell.

Then, if you want a second: **4.2 (FMCSA)**, because it's monthly rather
than 5-minutely, so it costs almost nothing to run in parallel, and the
buyer — insurance — has the shortest path from "interesting" to "invoiced."

### Concretely, over two weeks

1. **Day 1 — verify the one load-bearing assumption.** Pull the openFDA
   drug shortage endpoint and the FDA Excel file. Determine empirically
   whether resolved shortages persist or vanish, and how the two sources
   disagree. If resolved records persist indefinitely with accurate
   resolution dates, drop to 4.2 and don't look back.
2. **Day 2 — start the clock.** Poller + raw table + `ingest_runs`, on the
   existing Worker cron. Do this *before* the parser is good, before the
   schema is right, before there's a UI. Store the raw payload verbatim;
   your append-only design means a wrong parser today is recoverable and a
   missing poll is not.
3. **Week 1 — port the event deriver.** `shortage_events` with
   `started_at` / `ended_at` / `peak_severity` / `reason` / `manufacturer`,
   reusing the `MISSING_TOLERANCE` logic and both unique indexes (open-event
   and closed-event) verbatim.
4. **Week 2 — one number nobody else publishes.** Median shortage duration
   by therapeutic class, with a live count of currently-open shortages and
   days-elapsed. That single chart is the entire outbound pitch.
5. **Then go find the telecom.** Post it where hospital pharmacy and supply
   chain people actually are (ASHP communities, r/pharmacy, health-system
   supply chain LinkedIn). PowerOutage.us's business started when a customer
   arrived *at the free public thing*. Yours will too, or it won't — but
   either way the dataset keeps compounding while you wait.

### The one rule

Whatever you pick, **start ingesting before you finish designing.** Your own
`DEPLOY.md` already states the principle, and it is the only part of this
that is genuinely urgent. Parsers can be rewritten against stored raw
payloads. Schemas can be migrated. Dashboards can be thrown away. The one
thing that cannot be fixed later is a day you didn't poll.

---

## Sources

- FDA drug shortage retention & Wayback reconstruction — [NCBI: Analysis of Drug Shortages, 2018-2023](https://www.ncbi.nlm.nih.gov/books/NBK611681/), [FDA Drug Shortages](https://www.fda.gov/drugs/drug-safety-and-availability/drug-shortages), [openFDA drug shortages](https://open.fda.gov/apis/drug/drugshortages), [ASPE data brief](https://aspe.hhs.gov/sites/default/files/documents/efa332939da2064fa2c132bb8e842bb5/Drug%20Shortages_Data%20Brief_Final_2025.01.10.pdf)
- FMCSA SMS monthly snapshot & insurance impact — [FMCSA SMS Help Center](https://ai.fmcsa.dot.gov/SMS/HelpCenter/Index.aspx), [CSA Prioritization Preview](https://csa.fmcsa.dot.gov/prioritizationpreview), [COGO Insurance: SMS scores & trucking insurance](https://cogoinsurance.com/fmcsa-sms-score-explained/)
- Payer policy monitoring market — [Valeris / Policy Reporter](https://www.policyreporter.com/resources/streamliningpayercompliance/), [MD Clarity on payer policy changes](https://www.mdclarity.com/blog/payer-policy-changes), [Highmark medical policy update bulletin (redlined)](https://providers.highmark.com/content/dam/highmark/en/providerresourcecenter/pdfs/all/documents/pdfs/latest-updates/medical-policy-update/2026/mpu-may-26-2026.pdf), [UMR policy update bulletin](https://www.uhcprovider.com/content/dam/provider/docs/public/policies/mpub-archives/umr/umr-medical-policy-update-bulletin-january-2026.pdf)
- Hospital price transparency — [CMS Hospital Price Transparency](https://www.cms.gov/priorities/key-initiatives/hospital-price-transparency), [CMS price-transparency-guide](https://github.com/CMSgov/price-transparency-guide), [Trilliant Health](https://www.trillianthealth.com/analytics/price-transparency)
- Interconnection queues (already served) — [interconnection.fyi](https://www.interconnection.fyi/), [Grid Status docs](https://docs.gridstatus.io/monitor/interconnection-queue), [Pearl Street Technologies](https://pearlstreettechnologies.com/articles/blog/iso-and-utility-interconnection-queues-blog/)
- USCIS (already served) — [USCIS Historic Processing Times](https://egov.uscis.gov/processing-times/historic-pt), [AILA: Processing Times Roller Coaster](https://www.aila.org/blog/information-overload-a-ride-aboard-the-uscis-processing-times-roller-coaster/)
- PowerOutage.us proof case — [About PowerOutage.us](https://poweroutage.us/about), [Use Our Data](https://poweroutage.us/use-our-data), [CNN profile](https://www.cnn.com/2025/03/04/us/poweroutage-us-map-severe-weather)
