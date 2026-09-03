# UTIL-ACQ-001 — UK Utilities Public-Source Census and Acquisition Design

**Package ID:** UTIL-ACQ-001 (SOTERIUS-UTILITIES-PUBLIC-SOURCE-CENSUS-AND-ACQUISITION-DESIGN-01)
**Status:** RESEARCH ONLY — **NOT a governed authority.** Not registered in `DOCUMENT_REGISTER.md`, not citable for conformance, not integrated into any production path.
**Research date:** 2026-09-03
**Scope:** Read-only discovery and design. No production, canonical data, schema, migration, admission, monitoring, scoring, scheduler or deployment change. No domains discovered, inferred or looked up. No DNS. No scanning. No PR.
**Related context (context only — not operationalised here):** `research/REG-UTIL-001-uk-utilities-regulatory-signal-mapping.md`

> ### ⚠️ RETRIEVAL LIMITATION — READ FIRST
>
> **Not one source in this census was retrieved.** The session egress policy blocked
> every candidate acquisition host, confirmed individually:
>
> | Host | Result |
> |---|---|
> | `www.ofgem.gov.uk` | EGRESS_BLOCKED |
> | `www.ofwat.gov.uk` | EGRESS_BLOCKED |
> | `www.elexon.co.uk` | EGRESS_BLOCKED |
> | `www.find-tender.service.gov.uk` | EGRESS_BLOCKED |
> | `environment.data.gov.uk` | EGRESS_BLOCKED |
> | `www.data.gov.uk` | EGRESS_BLOCKED |
> | `www.ofcom.org.uk` | EGRESS_BLOCKED (established earlier in session) |
> | `www.gov.uk`, `assets.publishing.service.gov.uk`, `www.legislation.gov.uk` | EGRESS_BLOCKED |
>
> Consequently, per the brief's explicit instruction never to invent record counts:
>
> - **Every record count, unique-entity count and relationship count in this package is
>   `UNKNOWN`.** No count is estimated, inferred, or carried over from model knowledge.
> - **Every source carries retrieval status `SEARCH-DISCOVERED` or `BLOCKED`. None is
>   `VERIFIED`.** Format, cadence and field-availability assertions come from search-index
>   summaries of official pages, not from inspecting the artefacts.
> - **Stage 13 states no scale band.** The evidence does not permit one. §18 explains
>   precisely which single retrieval would settle it.
>
> What this package *can* deliver without retrieval — and does — is the source census,
> the identity analysis against this repository's actual identity code, the acquisition
> model, the relationship and temporal design, the canonical-model fit, and a
> first-package recommendation. Those rest on repository inspection (which was
> unrestricted) and on source identification (which search supports).

---

## 1. Executive summary

**Answer to the final question: yes — and the highest-value first layer is UTIL-01, the
Ofgem electricity licensee spine.**

Eleven findings carry this package:

1. **A domain-free acquisition is not merely possible here, it is the natural shape.**
   This repository's identity precedence (`organisation/identity.js`) resolves on
   **Companies House number first**. Domain appears only in the keyless fallback
   (`nd:sha(normalisedName|domain)`). Any source carrying a company number produces a
   stable canonical `ORG-` id with **no domain involvement whatsoever**.

2. **Ofgem's licensee lists appear to carry company numbers directly.** A search-surfaced
   Ofgem electricity licensee artefact is structured `Licensee | Company No | Licence Type`
   **[SEARCH-DISCOVERED]**. If that holds on retrieval, the electricity spine lands
   directly on the strongest identifier in the precedence chain — the single most
   valuable fact in this census.

3. **But those lists are PDFs, and Ofgem disclaims them.** Ofgem states that lists of all
   licensees are **not formal Public Register documents and should not be relied upon**,
   directing users to the Electronic Public Register at `epr.ofgem.gov.uk`
   **[SEARCH-DISCOVERED]**. This is a genuine authority/machine-readability tension and
   §4.2 addresses it head-on rather than glossing it.

4. **The procurement graph has a real, documented machine-readable path.** Find a Tender
   publishes OCDS at `GET https://www.find-tender.service.gov.uk/api/1.0/ocdsReleasePackages`
   (≤100 releases/page), and the Open Contracting Partnership mirrors the UK FTS
   publication with JSON/Excel/CSV downloads by year or all-time
   **[SEARCH-DISCOVERED]**. The mirror is operationally significant: it offers bulk
   access without paging a live regulator API.

5. **Procurement law changed under this package's feet.** The Procurement Act 2023
   regime and the enhanced Find a Tender / Central Digital Platform went live
   **24 February 2025**, consolidating the previous Contracts Finder / FTS split
   **[SEARCH-DISCOVERED]**. Any acquisition design must treat pre- and post-24-Feb-2025
   notices as **two different data regimes**, not one continuous series.

6. **Recommended acquisition model: C — Hybrid, buyer-seeded primary.** Seed from the
   authoritative operator spine and acquire awards where those organisations are buyers;
   use utility CPV codes only as a secondary recall net whose output is
   `PROCUREMENT_CANDIDATE`, never a confirmed relationship. Reasoning in §10.

7. **Three canonical objects the brief assumes do not exist in this repository.**
   `Relationship` and `Attribution` have **no implementation**, and the `memberships`
   table (migration 024) is **customer/tenant membership (user↔customer), not
   organisation↔cohort membership**. §20 reports this plainly rather than pretending the
   ten-object model is fully realised here. The supplier graph's central object is the
   one that does not yet exist.

8. **No utilities identifier is in the identity precedence chain.** Ofgem licence
   numbers, Ofwat appointments, Ofcom Code-operator status and Elexon party ids/MPIDs are
   all absent from `primaryKeyOf()`. Admitting any as a strong identifier would require a
   governance disposition of the kind GCN-004 performed for FRC/HMRC/PBS. **This package
   does not propose one** — §8 shows why utilities acquisition does not need it.

9. **Cross-cohort overlap is UNMEASURED, and the brief's cohort list overstates what is
   in this repository.** Repository inspection shows acquisition machinery and registries
   for **FCA, SRA, IF, PRA and HE** only. **No Defence/MOD, Rail, NHS or general Education
   population exists in this repository.** No production read was attempted. §15.

10. **Environment Agency is a candidate layer and must stay one.** Permit holder ≠
    critical infrastructure operator. It generates candidates for resolution, never
    memberships. §13.

11. **Recommended first package: UTIL-01 — Ofgem Electricity Operator Spine.** Highest
    authority, plausible company numbers, smallest ambiguity, no dependency on any other
    layer, and it is the seed list every procurement layer needs. §22.

---

## 2. Operator spine

### 2.1 What a "spine" is in this design

The spine is the set of organisations whose **regulated role is established by an
authoritative register entry**, not inferred. It is the evidential floor of the cohort:
every later layer either resolves against it or is explicitly marked as candidate
material.

Spine membership requires all three of:

1. an **authoritative publisher** (statutory regulator, code administrator, or system
   operator acting under licence);
2. a **named legal entity** as published; and
3. a **role or licence class** attributable from the source record itself.

An organisation that fails (3) but passes (1) and (2) is still acquired — it is retained
as role-unresolved rather than discarded (§12, §17).

### 2.2 Role taxonomy — do not flatten

The brief is right to insist these are not one category. The proposed role vocabulary,
kept deliberately close to the licence classes the sources themselves publish:

**Electricity**
- `ELEC_TRANSMISSION_OWNER`
- `ELEC_TRANSMISSION_OFFSHORE` (OFTO)
- `ELEC_SYSTEM_OPERATOR`
- `ELEC_DISTRIBUTION_DNO`
- `ELEC_DISTRIBUTION_IDNO`
- `ELEC_INTERCONNECTOR`
- `ELEC_GENERATION`
- `ELEC_SUPPLY` (retail — **market participant, not infrastructure**)
- `ELEC_SMART_METER_COMMS` (DCC/smart-meter communication licence)

**Gas**
- `GAS_TRANSMISSION_NTS`
- `GAS_DISTRIBUTION_GDN`
- `GAS_TRANSPORTER_INDEPENDENT` (iGT)
- `GAS_INTERCONNECTOR`
- `GAS_SHIPPER` (**commodity/trading, not infrastructure**)
- `GAS_SUPPLY` (retail — **market participant, not infrastructure**)

**Water**
- `WATER_UNDERTAKER`
- `SEWERAGE_UNDERTAKER`
- `WATER_AND_SEWERAGE_UNDERTAKER`
- `WATER_NAV` (new appointment/variation)
- `WATER_WSSL` (retail licence — **market participant, not infrastructure**)
- `WATER_INFRASTRUCTURE_PROVIDER` (IP project licence)

**Communications**
- `COMMS_CODE_OPERATOR` (Ofcom Code powers)
- `COMMS_NETWORK_INFRASTRUCTURE`
- `COMMS_TOWER_INFRASTRUCTURE`

**Market-role overlay (Elexon, non-exclusive)**
- `BSC_PARTY`, `BSC_SIGNATORY`, `BSC_QUALIFIED_PERSON`, plus published market roles/MPIDs.

**Design rule.** `role` is an **attribute of the evidence**, not of the organisation. One
organisation may legitimately hold `ELEC_DISTRIBUTION_DNO`, `GAS_DISTRIBUTION_GDN` and
`ELEC_SUPPLY` through different legal entities in the same group, or through one entity
with several licences. The acquisition must be able to record all of them against
separate source records without a merge decision at acquisition time (§8.4).

### 2.3 Infrastructure vs market participation

The brief requires this separation and it is load-bearing for cohort quality:

| Category | Roles | Why it matters |
|---|---|---|
| **Infrastructure operator** | transmission, distribution, system operation, interconnector, NTS, GDN, iGT, undertakers, NAVs, Code operators | Owns/operates physical assets; the genuine critical-infrastructure population |
| **Market participant / retail** | electricity supply, gas supply, WSSL, shipping, trading | Licensed and regulated, but does not operate infrastructure |
| **Generation** | generation licences, capacity-market units | Infrastructure-adjacent; in or out of scope depends on threshold and purpose — treat as its own class, never merged into either above |
| **Code/market role** | BSC parties, qualified persons | An overlay describing participation, not an operator type |

Collapsing retail suppliers into "utility infrastructure operators" would be the single
most damaging quality error available in this cohort, and it is the error the raw source
lists most invite — Ofgem's own list titles are "all electricity licensees **including
suppliers**" **[SEARCH-DISCOVERED]**.

---

## 3. Full source census

**Legend.** Retrieval: `VERIFIED` (retrieved and inspected) · `SEARCH-DISCOVERED`
(identified via search index; official URL captured; artefact not inspected) · `BLOCKED`
(retrieval attempted and refused by egress policy). **No source in this census is
VERIFIED.** All counts `UNKNOWN` — see banner.

---

### 3.1 Ofgem — Electronic Public Register

| Field | Value |
|---|---|
| **Source** | Ofgem Electronic Public Register (EPR) |
| **Publisher** | Ofgem |
| **URL** | `https://epr.ofgem.gov.uk/` |
| **Sector** | Electricity, Gas |
| **Population represented** | All licensees and their licence documents/conditions in force |
| **Role granularity** | Licence type and conditions per licensee — **the authoritative role source** |
| **Format** | HTML application (search interface) |
| **Machine-readable** | UNKNOWN — likely PARTIAL/NO |
| **Bulk-downloadable** | UNKNOWN — likely NO |
| **Record count** | UNKNOWN |
| **Unique organisation estimate** | UNKNOWN |
| **Company number available** | UNKNOWN |
| **Registered name** | YES (licensee name) |
| **Address** | UNKNOWN |
| **Licence / role identifier** | YES |
| **Update cadence** | Continuous (authoritative register) |
| **Source authority** | **PRIMARY** |
| **Retrieval status** | **BLOCKED** (host `ofgem.gov.uk` blocked; EPR subdomain not separately probed) |
| **Acquisition suitability** | **MEDIUM** |
| **Notes** | The definitive authority, and Ofgem directs users here in preference to its own lists **[SEARCH-DISCOVERED]**. Suitability is capped at MEDIUM only because bulk machine access is unknown and likely absent — an authority problem solved, an engineering problem created. Correct role for this source: **verification and role-attribution reference**, not bulk acquisition. |

### 3.2 Ofgem — List of all electricity licensees including suppliers

| Field | Value |
|---|---|
| **Source** | List of all electricity licensees including suppliers |
| **Publisher** | Ofgem |
| **URL** | `https://www.ofgem.gov.uk/data/list-all-electricity-licensees-including-suppliers` |
| **Sector** | Electricity |
| **Population represented** | All electricity licensees: transmission, distribution (DNO and IDNO), interconnector, generation, supply, and other classes |
| **Role granularity** | **YES — licence type per licensee** |
| **Format** | PDF (an observed artefact is structured `Licensee | Company No | Licence Type`) **[SEARCH-DISCOVERED]** |
| **Machine-readable** | **PARTIAL** — tabular PDF; extractable but not a data format |
| **Bulk-downloadable** | **YES** (single document) |
| **Record count** | **UNKNOWN** |
| **Unique organisation estimate** | **UNKNOWN** |
| **Company number available** | **YES (apparent)** — from the observed column structure **[SEARCH-DISCOVERED]** |
| **Registered name** | YES |
| **Address** | PARTIAL — a companion Ofgem artefact is titled "Electricity Registered or service addresses" **[SEARCH-DISCOVERED]** |
| **Licence / role identifier** | YES (licence type; licence number UNKNOWN) |
| **Update cadence** | Periodic reissue; a version dated **17 August 2026** was surfaced **[SEARCH-DISCOVERED]** |
| **Source authority** | **PRIMARY publisher, but explicitly non-authoritative artefact** — see Notes |
| **Retrieval status** | **BLOCKED** |
| **Acquisition suitability** | **VERY HIGH** |
| **Notes** | The strongest single acquisition candidate in this census: authoritative publisher, sector-complete, role-bearing, and apparently carrying the company number that resolves straight to the top of this repository's identity precedence. **Caveat that must be preserved in provenance:** Ofgem states such lists are *not formal Public Register documents and should not be relied upon* **[SEARCH-DISCOVERED]**. Acquire it as *Ofgem-published evidence*, cite the EPR as the authority it defers to, and never record it as the register itself. |

### 3.3 Ofgem — List of all gas licensees including suppliers

| Field | Value |
|---|---|
| **Source** | List of all gas licensees including suppliers |
| **Publisher** | Ofgem |
| **URL** | `https://www.ofgem.gov.uk/data/list-all-gas-licensees-including-suppliers` |
| **Sector** | Gas |
| **Population represented** | All gas licensees: transporters (NTS, GDNs, iGTs), shippers, suppliers, interconnectors |
| **Role granularity** | **YES** — includes an explicit independent Gas Transporter (iGT) category **[SEARCH-DISCOVERED]** |
| **Format** | PDF (e.g. `all-gas-licensees-3-December-2025.pdf`) **[SEARCH-DISCOVERED]** |
| **Machine-readable** | **PARTIAL** |
| **Bulk-downloadable** | **YES** |
| **Record count** | **UNKNOWN** |
| **Unique organisation estimate** | **UNKNOWN** |
| **Company number available** | **UNKNOWN** — not observed for gas; assume parity with electricity only after retrieval |
| **Registered name** | YES |
| **Address** | UNKNOWN |
| **Licence / role identifier** | YES (licence class) |
| **Update cadence** | Periodic; versions dated 3 December 2025 and 17 August 2026 surfaced **[SEARCH-DISCOVERED]** |
| **Source authority** | PRIMARY publisher, non-authoritative artefact (same caveat as 3.2) |
| **Retrieval status** | **BLOCKED** |
| **Acquisition suitability** | **HIGH** |
| **Notes** | Structurally the twin of 3.2 and should be acquired by the same adapter. Rated HIGH rather than VERY HIGH solely because company-number presence is unconfirmed. Gas is where infrastructure/commodity separation matters most: transporters are infrastructure, **shippers are not**. |

### 3.4 Ofgem — Schedule 2: List of relevant licence holders

| Field | Value |
|---|---|
| **Source** | Schedule 2: List of relevant licence holders |
| **Publisher** | Ofgem |
| **URL** | `https://www.ofgem.gov.uk/sites/default/files/2023-11/Schedule%202_List%20of%20relevant%20licence%20holders.pdf` |
| **Sector** | Electricity, Gas |
| **Population represented** | Licence holders relevant to a specific instrument (scope unconfirmed) |
| **Role granularity** | UNKNOWN |
| **Format** | PDF |
| **Machine-readable** | PARTIAL |
| **Bulk-downloadable** | YES |
| **Record count / unique orgs** | **UNKNOWN** |
| **Company number / address / licence id** | UNKNOWN |
| **Update cadence** | Ad hoc (2023 artefact) |
| **Source authority** | PRIMARY |
| **Retrieval status** | **BLOCKED** |
| **Acquisition suitability** | **LOW** |
| **Notes** | Scope-specific and dated. Cross-reference material only; not a spine source. |

### 3.5 Elexon — BSC Signatories and Qualified Persons

| Field | Value |
|---|---|
| **Source** | BSC Signatories and Qualified Persons |
| **Publisher** | Elexon (BSC code administrator) |
| **URL** | `https://www.elexon.co.uk/bsc/about/elexon-key-contacts/bsc-signatories-qualified-persons/` |
| **Sector** | Electricity |
| **Population represented** | BSC Parties, signatories and qualified persons — electricity market participants |
| **Role granularity** | **YES** — market roles; the Qualified Person's Workbook exposes **MPIDs, Market Roles** for SVA Parties, SVA Party Agents and CVA Meter Operators **[SEARCH-DISCOVERED]** |
| **Format** | HTML page; workbook (spreadsheet) **[SEARCH-DISCOVERED]** |
| **Machine-readable** | **PARTIAL** (workbook likely YES) |
| **Bulk-downloadable** | PARTIAL |
| **Record count / unique orgs** | **UNKNOWN** |
| **Company number available** | **UNKNOWN — assume NO** |
| **Registered name** | YES |
| **Address** | UNKNOWN |
| **Licence / role identifier** | **YES — MPID and market role** (a party identifier, not a licence) |
| **Update cadence** | **Monthly** — Elexon publishes "Changes to BSC Parties and Qualified Persons" monthly **[SEARCH-DISCOVERED]** |
| **Source authority** | **PRIMARY** (code administrator) |
| **Retrieval status** | **BLOCKED** |
| **Acquisition suitability** | **MEDIUM** |
| **Notes** | Valuable as a **role overlay**, weak as a spine: likely no company number, so resolution depends on name matching against the Ofgem spine. The monthly change articles are an unusually good **temporal** source — they date entries and exits, which most registers do not. Acquire **after** UTIL-01 so MPIDs attach to already-resolved organisations. |

### 3.6 Elexon — BMRS / Insights (registration data)

| Field | Value |
|---|---|
| **Source** | Balancing Mechanism Reporting Service (BMRS) / Elexon Insights |
| **Publisher** | Elexon |
| **URL** | `https://www.elexon.co.uk/operations-settlement/bsc-central-services/balancing-mechanism-reporting-agent/` |
| **Sector** | Electricity |
| **Population represented** | Registration information sourced from the Central Registration Agent **[SEARCH-DISCOVERED]** |
| **Role granularity** | PARTIAL — BM Unit level, not organisation-role level |
| **Format** | **API** |
| **Machine-readable** | **YES** |
| **Bulk-downloadable** | PARTIAL |
| **Record count / unique orgs** | **UNKNOWN** |
| **Company number** | Assume **NO** |
| **Update cadence** | Continuous |
| **Source authority** | PRIMARY |
| **Retrieval status** | **BLOCKED** |
| **Acquisition suitability** | **LOW–MEDIUM** |
| **Notes** | Machine-readable, but oriented to **units and settlement**, not organisation identity. Elexon publishes explicit copyright/licence terms for BMRS API and open data **[SEARCH-DISCOVERED]** — **licence terms must be read before any acquisition**, a gate that does not apply to the Ofgem/Ofwat lists. Low priority for an organisation-first package. |

### 3.7 NESO — Capacity Market Register

| Field | Value |
|---|---|
| **Source** | Capacity Market Register |
| **Publisher** | NESO (National Energy System Operator), EMR Delivery Body |
| **URL** | `https://www.neso.energy/data-portal/capacity-market-register` |
| **Sector** | Electricity (generation/capacity) |
| **Population represented** | All applications to the Delivery Body ahead of each capacity auction, those awarded Capacity Agreements, and enduring obligations **[SEARCH-DISCOVERED]** |
| **Role granularity** | **YES** — CMU and component level, with de-rating and auction detail |
| **Format** | **CSV — eight files** (component history, CMU history, components, CMU data, component history pre-aggregation, auction capacity and cost, de-rating factors, auction static data) **[SEARCH-DISCOVERED]** |
| **Machine-readable** | **YES** |
| **Bulk-downloadable** | **YES** |
| **Record count / unique orgs** | **UNKNOWN** |
| **Company number available** | **UNKNOWN** |
| **Registered name** | YES (applicant/agreement holder) |
| **Licence / role identifier** | **YES — CMU identifier** |
| **Update cadence** | Weekly publication; register updated at **one-hour frequency** **[SEARCH-DISCOVERED]** |
| **Source authority** | **PRIMARY** |
| **Retrieval status** | **BLOCKED** |
| **Acquisition suitability** | **HIGH** (for the generation/capacity class only) |
| **Notes** | The **best machine-readability in the entire energy census** — genuine bulk CSV with component-level history. Two cautions: it is **auction-participation** evidence, not infrastructure-operator evidence, so it populates `ELEC_GENERATION` and must not be promoted into the operator spine; and record counts are at unit level, so unique-organisation count will be far lower than row count and is `UNKNOWN` until measured. |

### 3.8 NESO — Data Portal (general)

| Field | Value |
|---|---|
| **Source** | NESO Data Portal |
| **Publisher** | NESO |
| **URL** | `https://www.neso.energy/data-portal` |
| **Sector** | Electricity |
| **Population represented** | Multiple datasets including BMU public registration guidance **[SEARCH-DISCOVERED]** |
| **Format** | CSV / portal |
| **Machine-readable** | **YES (apparent)** |
| **Record count** | **UNKNOWN** |
| **Source authority** | PRIMARY |
| **Retrieval status** | **BLOCKED** |
| **Acquisition suitability** | **MEDIUM — requires cataloguing** |
| **Notes** | Likely contains further organisation-bearing registers. Treat as a **catalogue to enumerate on first unrestricted retrieval**, not a single source. |

### 3.9 Ofwat — Licences and licensees

| Field | Value |
|---|---|
| **Source** | Licences and licensees |
| **Publisher** | Ofwat |
| **URL** | `https://www.ofwat.gov.uk/regulated-companies/ofwat-industry-overview/licences/` |
| **Sector** | Water |
| **Population represented** | Water undertakers, sewerage undertakers, Infrastructure Provider project licences, WSSL holders **[SEARCH-DISCOVERED]** |
| **Role granularity** | **YES** — appointment/licence type distinguishes undertaker from retail licensee |
| **Format** | HTML (instruments of appointment likely PDF) |
| **Machine-readable** | **PARTIAL / NO** |
| **Bulk-downloadable** | **UNKNOWN — likely NO** |
| **Record count / unique orgs** | **UNKNOWN** |
| **Company number available** | **UNKNOWN** |
| **Registered name** | YES |
| **Address** | UNKNOWN |
| **Licence / role identifier** | YES (instrument of appointment / licence) |
| **Update cadence** | On appointment/variation |
| **Source authority** | **PRIMARY** |
| **Retrieval status** | **BLOCKED** |
| **Acquisition suitability** | **HIGH** |
| **Notes** | Ofwat holds the original Instruments of Appointment for water and sewerage undertakers, IP project licences and WSSLs **[SEARCH-DISCOVERED]** — an unambiguous authority. The undertaker population is small and stable, so even manual-grade extraction is tractable; the constraint is format, not authority. |

### 3.10 Ofwat — Register of new appointments and variations (NAVs)

| Field | Value |
|---|---|
| **Source** | Register of new appointments and variations granted to date |
| **Publisher** | Ofwat |
| **URL** | `https://www.ofwat.gov.uk/publication/register-of-new-appointments-and-variations-granted-to-date/` |
| **Sector** | Water |
| **Population represented** | All NAVs granted to date **[SEARCH-DISCOVERED]** |
| **Role granularity** | **YES — `WATER_NAV`, per appointment** |
| **Format** | Publication (PDF/XLSX — UNKNOWN) |
| **Machine-readable** | **UNKNOWN** |
| **Bulk-downloadable** | **YES (single publication)** |
| **Record count / unique orgs** | **UNKNOWN** — and note **appointments ≠ organisations**: one NAV company holds many appointments |
| **Company number available** | UNKNOWN |
| **Registered name** | YES |
| **Licence / role identifier** | YES (appointment) |
| **Geography** | **YES — appointments are to a specific geographic area** **[SEARCH-DISCOVERED]** |
| **Update cadence** | Updated as appointments are granted; Ofwat updated NAV licensing policy May 2026 **[SEARCH-DISCOVERED]** |
| **Source authority** | **PRIMARY** |
| **Retrieval status** | **BLOCKED** |
| **Acquisition suitability** | **HIGH** |
| **Notes** | **Directly answers the brief's NAV geography question: yes.** A NAV is an appointment to provide services *to a specific geographic area instead of the existing appointed company* **[SEARCH-DISCOVERED]**. Each appointment is therefore evidence of an operator–site–incumbent triangle. That is genuinely useful later, but it is **site/geography evidence, not a supplier relationship** — do not let it leak into the supplier graph. It also implies a one-to-many organisation→appointment cardinality that the acquisition must preserve rather than deduplicate away. |

### 3.11 Ofwat — WSSL (Water Supply and Sewerage Licences)

| Field | Value |
|---|---|
| **Source** | Water supply and sewerage licences (incl. "WSSL Applications Refused") |
| **Publisher** | Ofwat |
| **URL** | `https://www.ofwat.gov.uk/regulated-companies/markets/business-retail-market/water-supply-sewerage-licences/` |
| **Sector** | Water |
| **Population represented** | WSSL holders supplying eligible non-household customers since 1 April 2017 **[SEARCH-DISCOVERED]** |
| **Role granularity** | **YES — `WATER_WSSL` (retail, NOT infrastructure)** |
| **Format** | HTML |
| **Machine-readable** | PARTIAL / NO |
| **Record count / unique orgs** | **UNKNOWN** |
| **Company number** | UNKNOWN |
| **Update cadence** | On grant/refusal |
| **Source authority** | **PRIMARY** |
| **Retrieval status** | **BLOCKED** |
| **Acquisition suitability** | **MEDIUM** |
| **Notes** | Rated MEDIUM because WSSL holders are **retail market participants**, not infrastructure operators — valuable for completeness and correct classification, not for the critical-infrastructure core. Ofwat also publishes **refused** applications, which are explicitly **not** licensees and must never be acquired as such. |

### 3.12 Ofcom — Register of persons with powers under the Electronic Communications Code

| Field | Value |
|---|---|
| **Source** | Register of persons with powers under the Electronic Communications Code |
| **Publisher** | Ofcom |
| **URL** | `https://www.ofcom.org.uk/phones-and-broadband/telecoms-infrastructure/register` |
| **Sector** | Communications |
| **Population represented** | Organisations granted Code powers by Ofcom — network providers and providers of infrastructure supporting such networks **[SEARCH-DISCOVERED]** |
| **Role granularity** | **PARTIAL** — Code-operator status is binary; provider vs infrastructure-provider distinction is described in guidance, not necessarily in the register rows |
| **Format** | **HTML, A–Z paginated list** **[SEARCH-DISCOVERED]** |
| **Machine-readable** | **NO** |
| **Bulk-downloadable** | **NO** |
| **Record count / unique orgs** | **UNKNOWN** |
| **Company number available** | **UNKNOWN — assume NO** |
| **Registered name** | YES |
| **Address** | UNKNOWN |
| **Licence / role identifier** | PARTIAL (Code-operator designation; no number observed) |
| **Update cadence** | On direction (Ofcom publishes ECC directions) |
| **Source authority** | **PRIMARY** |
| **Retrieval status** | **BLOCKED** |
| **Acquisition suitability** | **MEDIUM** |
| **Notes** | The correct statutory population for communications **infrastructure** — Code powers are precisely the right filter, since they attach to those installing and maintaining apparatus **[SEARCH-DISCOVERED]**. Held back to MEDIUM by format (A–Z HTML, no bulk, no download) and probable absence of company numbers, which pushes resolution onto name matching. **Keep telecoms regulatory status entirely separate from NIS/utilities status** (REG-UTIL-001 §5) — this is population acquisition, not regulatory equivalence. |

### 3.13 Find a Tender Service — OCDS API

| Field | Value |
|---|---|
| **Source** | Find a Tender Service (Central Digital Platform) OCDS API |
| **Publisher** | UK Government (Cabinet Office / DSIT estate) |
| **URL** | `https://www.find-tender.service.gov.uk/api/1.0/ocdsReleasePackages` · docs `https://www.find-tender.service.gov.uk/apidocumentation/1.0/GET-ocdsReleasePackages` |
| **Sector** | Cross-sector (procurement) |
| **Population represented** | UK public-sector and utilities procurement notices — tenders and contract awards |
| **Role granularity** | **YES** — buyer and awarded supplier are distinct parties in OCDS |
| **Format** | **JSON (Open Contracting Data Standard)** |
| **Machine-readable** | **YES** |
| **Bulk-downloadable** | **PARTIAL** — paged at **≤100 releases per page** **[SEARCH-DISCOVERED]** |
| **Record count / unique orgs** | **UNKNOWN** |
| **Company number available** | **PARTIAL** — OCDS party identifier schemes commonly carry a company registration id; presence per-notice **UNKNOWN** until retrieved |
| **Registered name** | YES (buyer and supplier names) |
| **Address** | PARTIAL (OCDS supports party addresses) |
| **Notice / contract identifier** | **YES — OCID and notice id** |
| **Update cadence** | Continuous |
| **Source authority** | **PRIMARY** |
| **Retrieval status** | **BLOCKED** |
| **Acquisition suitability** | **VERY HIGH** (for the supplier graph) |
| **Notes** | The backbone of any supplier graph. Enhanced FTS under the Procurement Act 2023 went live **24 February 2025**, consolidating the previous Contracts Finder (below-threshold) / FTS (above-threshold) split **[SEARCH-DISCOVERED]**. **Treat pre- and post-24-Feb-2025 as two regimes** with different notice types, party modelling and identifier practice. Paging at 100/page makes full historical acquisition slow — hence 3.14. |

### 3.14 Open Contracting Partnership — UK Find a Tender Service mirror

| Field | Value |
|---|---|
| **Source** | "United Kingdom: Find a Tender Service" OCDS publication |
| **Publisher** | Open Contracting Partnership (mirror of the UK primary source) |
| **URL** | `https://data.open-contracting.org/en/publication/41` |
| **Sector** | Cross-sector (procurement) |
| **Population represented** | The FTS OCDS dataset, retrieved from the FTS API **weekly** **[SEARCH-DISCOVERED]** |
| **Role granularity** | As FTS |
| **Format** | **JSON, Excel or CSV** **[SEARCH-DISCOVERED]** |
| **Machine-readable** | **YES** |
| **Bulk-downloadable** | **YES — by year or for all time** **[SEARCH-DISCOVERED]** |
| **Record count / unique orgs** | **UNKNOWN** |
| **Update cadence** | **Weekly** |
| **Source authority** | **SECONDARY** (faithful mirror of a primary source) |
| **Retrieval status** | **BLOCKED** (host not separately probed; assume blocked) |
| **Acquisition suitability** | **HIGH** |
| **Notes** | Operationally the most attractive procurement access path — bulk, all-time, three formats, no paging. **But it is SECONDARY**, and this repository's provenance discipline requires the authority to be the publisher, not the mirror. Recommended use: **acquire via the mirror for coverage, cite FTS as the source, and record the mirror as the retrieval channel** with its weekly lag noted. Never let a mirror row masquerade as a primary retrieval. |

### 3.15 Contracts Finder

| Field | Value |
|---|---|
| **Source** | Contracts Finder |
| **Publisher** | UK Government |
| **URL** | `https://www.contractsfinder.service.gov.uk/` (OCDS guide: `assets.publishing.service.gov.uk/media/5e99b67dd3bf7f0318cff3b8/…V.2.1.pdf`) |
| **Sector** | Cross-sector (procurement) |
| **Population represented** | Historic below-threshold and legacy notices |
| **Format** | **OCDS via API; bulk publication accessible from data.gov.uk** **[SEARCH-DISCOVERED]** |
| **Machine-readable** | **YES** |
| **Bulk-downloadable** | **YES (apparent)** |
| **Record count / unique orgs** | **UNKNOWN** |
| **Update cadence** | Superseded for new notices from 24 Feb 2025 **[SEARCH-DISCOVERED]** |
| **Source authority** | **PRIMARY (historic)** |
| **Retrieval status** | **BLOCKED** |
| **Acquisition suitability** | **MEDIUM** |
| **Notes** | Now principally a **historical** source. Valuable precisely because expired relationships remain evidence (§12), so it extends the supplier graph backwards. Do not treat it as a current-notice source. |

### 3.16 Devolved procurement portals

| Source | Publisher | URL | Retrieval | Suitability | Notes |
|---|---|---|---|---|---|
| Public Contracts Scotland | Scottish Government | `publiccontractsscotland.gov.uk` | **SEARCH-DISCOVERED (not probed)** | **MEDIUM** | Required for Scottish water (a public corporation) and Scottish network operators. Whether Scottish notices also surface in FTS is **UNKNOWN** and is a duplication risk to test before acquiring separately. |
| Sell2Wales | Welsh Government | `sell2wales.gov.wales` | **SEARCH-DISCOVERED (not probed)** | **MEDIUM** | Relevant to Welsh water and networks. Same overlap question. |
| eTendersNI | NI Executive | `etendersni.gov.uk` | **SEARCH-DISCOVERED (not probed)** | **LOW–MEDIUM** | NI utilities sit under distinct regulatory arrangements (REG-UTIL-001 §3.1 records NI as UNRESOLVED). Lowest priority. |

**Design note.** All three are deferred to a later layer. Acquiring them before measuring
FTS overlap risks importing duplicate award records under different notice identifiers —
which would corrupt relationship counts, the one metric this cohort is meant to produce
cleanly.

### 3.17 Environment Agency — Public Registers Online

| Field | Value |
|---|---|
| **Source** | Public Registers Online (Environmental Permitting Regulations) |
| **Publisher** | Environment Agency / Defra |
| **URL** | `https://environment.data.gov.uk/public-register/view/index` |
| **Sector** | Cross-sector (environmental permitting) |
| **Population represented** | Permit and licence holders: **Installations**, **Discharges to Water and Groundwater**, **Waste Operations**, and others **[SEARCH-DISCOVERED]** |
| **Role granularity** | **PARTIAL** — permit category, not operator role |
| **Format** | HTML search; **complete-register download in zip archive** for waste operations **[SEARCH-DISCOVERED]**; Defra API portal also referenced |
| **Machine-readable** | **YES (apparent, for bulk downloads)** |
| **Bulk-downloadable** | **YES (at least partially)** |
| **Record count / unique orgs** | **UNKNOWN** — and expected to be **large**, with heavy operator↔site multiplicity |
| **Company number available** | **UNKNOWN — assume NO** |
| **Registered name** | YES (operator name as permitted) |
| **Address** | **YES (site address expected)** |
| **Permit identifier** | **YES** |
| **Site/facility relationship** | **YES — permits are site-based** |
| **Update cadence** | UNKNOWN (periodic) |
| **Source authority** | **PRIMARY** |
| **Retrieval status** | **BLOCKED** |
| **Acquisition suitability** | **MEDIUM — as a CANDIDATE layer only** |
| **Notes** | See §13. Permit holder ≠ critical infrastructure operator, and this register will contain very large numbers of organisations with no infrastructure role at all. Its genuine value is **site-level** evidence and **operator-name recall**, not membership. |

### 3.18 Companies House (already integrated in this repository)

| Field | Value |
|---|---|
| **Source** | Companies House Public Data API / bulk product |
| **Publisher** | Companies House |
| **URL** | `https://api.company-information.service.gov.uk/` |
| **Sector** | Cross-sector (identity) |
| **Population represented** | All registered UK companies |
| **Format** | **JSON API + bulk** |
| **Machine-readable** | **YES** |
| **Record count** | **UNKNOWN** (not measured here) |
| **Company number** | **YES — the identifier itself** |
| **Source authority** | **PRIMARY** |
| **Retrieval status** | **BLOCKED this session** — but **already integrated** in this repository (`acquisition/companies-house-api-source.js`, `acquisition/ch-address-lookup.js`, `organisation/adapters/companiesHouse.js`) |
| **Acquisition suitability** | **VERY HIGH — as the resolution substrate, not a population** |
| **Notes** | **Not a utilities population and must not be used as one** — the brief rightly excludes broad company directories. Its role is confirmation and enrichment of names/numbers/addresses for organisations already evidenced by a regulator. Existing adapters mean this layer needs no new engineering. |

### 3.19 Census summary

| # | Source | Sector | Machine-readable | Bulk | Authority | Retrieval | Suitability |
|---|---|---|---|---|---|---|---|
| 3.1 | Ofgem EPR | Elec/Gas | PARTIAL/NO | NO | PRIMARY | BLOCKED | MEDIUM |
| 3.2 | Ofgem electricity licensees | Elec | PARTIAL | YES | PRIMARY* | BLOCKED | **VERY HIGH** |
| 3.3 | Ofgem gas licensees | Gas | PARTIAL | YES | PRIMARY* | BLOCKED | HIGH |
| 3.4 | Ofgem Schedule 2 | Elec/Gas | PARTIAL | YES | PRIMARY | BLOCKED | LOW |
| 3.5 | Elexon BSC signatories | Elec | PARTIAL | PARTIAL | PRIMARY | BLOCKED | MEDIUM |
| 3.6 | Elexon BMRS/Insights | Elec | YES | PARTIAL | PRIMARY | BLOCKED | LOW–MEDIUM |
| 3.7 | NESO Capacity Market Register | Elec | **YES** | **YES** | PRIMARY | BLOCKED | HIGH |
| 3.8 | NESO Data Portal | Elec | YES | YES | PRIMARY | BLOCKED | MEDIUM |
| 3.9 | Ofwat licences and licensees | Water | PARTIAL/NO | UNKNOWN | PRIMARY | BLOCKED | HIGH |
| 3.10 | Ofwat NAV register | Water | UNKNOWN | YES | PRIMARY | BLOCKED | HIGH |
| 3.11 | Ofwat WSSL | Water | PARTIAL/NO | UNKNOWN | PRIMARY | BLOCKED | MEDIUM |
| 3.12 | Ofcom ECC register | Comms | **NO** | **NO** | PRIMARY | BLOCKED | MEDIUM |
| 3.13 | Find a Tender OCDS API | Procurement | **YES** | PARTIAL | PRIMARY | BLOCKED | **VERY HIGH** |
| 3.14 | OCP FTS mirror | Procurement | **YES** | **YES** | SECONDARY | BLOCKED | HIGH |
| 3.15 | Contracts Finder | Procurement | YES | YES | PRIMARY (historic) | BLOCKED | MEDIUM |
| 3.16 | Devolved portals | Procurement | UNKNOWN | UNKNOWN | PRIMARY | NOT PROBED | MEDIUM |
| 3.17 | EA Public Registers | Environment | YES | YES | PRIMARY | BLOCKED | MEDIUM (candidate) |
| 3.18 | Companies House | Identity | YES | YES | PRIMARY | BLOCKED (integrated) | VERY HIGH (substrate) |

\* Primary **publisher**; the artefact itself is disclaimed by Ofgem as not a formal
Public Register document **[SEARCH-DISCOVERED]**.

---

## 4. Electricity findings

### 4.1 Population structure

Electricity is the best-served sector in this census and the only one where a single
artefact plausibly delivers **name + company number + role** together (3.2).

Three distinct populations, which must not be merged:

1. **Licensed operators and participants** (Ofgem) — transmission, offshore transmission,
   system operation, DNO, IDNO, interconnector, generation, supply, smart-meter comms.
   Role is carried by licence type.
2. **Market participants** (Elexon) — BSC parties/signatories/qualified persons, with
   MPIDs and market roles. An *overlay* on population 1, plus entities population 1 may
   not contain.
3. **Capacity/generation participants** (NESO CMR) — CMU-level auction participation.
   Infrastructure-adjacent, not operator evidence.

### 4.2 The authority/machine-readability tension

This is the defining problem of the electricity spine and deserves a direct answer.

- The **authoritative** source (EPR, 3.1) is an HTML register with no evident bulk access.
- The **usable** source (licensee list, 3.2) is a bulk PDF that Ofgem **explicitly says
  should not be relied upon** **[SEARCH-DISCOVERED]**.

Three options, and the recommendation:

| Option | Assessment |
|---|---|
| Acquire from EPR only | Maximum authority, but likely per-licensee HTML retrieval and no confirmed bulk path. High engineering cost, high fragility, slow. |
| Acquire from the licensee list only | Fast and complete, but records a source Ofgem disclaims — and the disclaimer would be invisible downstream. |
| **Acquire the list; record the disclaimer in provenance; treat EPR as the authority of record for role/status verification** | **RECOMMENDED.** |

The recommended option works *because* this repository's provenance model already carries
a `confidence` field with values `verified` / `corroborated` / `inferred`
(`organisation/schema.js`). A licensee-list-derived fact is **`corroborated`**, not
`verified`; promotion to `verified` requires an EPR check. The disclaimer becomes a
first-class data property instead of a footnote — which is exactly the distinction the
Repository Authority discipline exists to preserve.

### 4.3 IDNOs, DNOs and the affiliate problem

IDNOs appear within the electricity licensee list and Ofgem has published extensively on
IDNO regulatory arrangements, including **licence applications from affiliates of
existing licensees** **[SEARCH-DISCOVERED]**. Two consequences:

- IDNO licence holders are frequently **affiliates within a group** — several licensed
  entities, one commercial parent. Acquisition must retain the **licensed legal entity**
  as published, not the group brand (§8.4).
- The same affiliate pattern exists for iGTs (Ofgem published on iGT licence holders as
  affiliates of existing licensees **[SEARCH-DISCOVERED]**), so gas and electricity share
  this failure mode.

### 4.4 Smart-meter communications

`ELEC_SMART_METER_COMMS` should be populated from the Ofgem licensee list where a
smart-meter communication licence class is present. A separate DCC-specific register was
**not identified** in this session — **UNRESOLVED** (§23).

---

## 5. Gas findings

Structurally parallel to electricity, with three differences that matter:

1. **Company number presence is unconfirmed.** Observed for electricity **[SEARCH-DISCOVERED]**,
   not for gas. If absent, the gas spine's identity quality drops a full tier and resolution
   falls back to name matching against Companies House. **This is the highest-value
   unknown in the gas layer.**

2. **Infrastructure/commodity separation is sharper and more consequential.** Gas
   transporters (NTS, GDNs, iGTs) operate physical infrastructure. **Shippers and
   suppliers do not.** Both appear in the same Ofgem list — titled "including suppliers"
   **[SEARCH-DISCOVERED]** — so the role field is doing essential work. An acquisition that
   drops role, or defaults it, silently converts a commodity trader into a critical
   infrastructure operator.

3. **iGTs mirror the IDNO affiliate pattern** (§4.3) and carry the same entity-preservation
   requirement.

Gas interconnectors and site-specific pipeline operators: presence and role granularity
within the gas licensee list are **UNKNOWN** — **UNRESOLVED** (§23).

---

## 6. Water findings

Water has the **best authority and the worst machine-readability** in the census.

- **Authority is unambiguous.** Ofwat holds the original Instruments of Appointment for
  water and sewerage undertakers, IP project licences and WSSLs **[SEARCH-DISCOVERED]**.
  There is no equivalent of Ofgem's "this list is not the register" disclaimer problem.
- **Format is the constraint.** No bulk machine-readable register was identified; the NAV
  register is a publication whose format is **UNKNOWN**.
- **The population is small and stable**, which changes the engineering calculus: an
  acquisition that would be untenable at scale is tractable here, and re-acquisition
  cadence can be low (appointments and variations are infrequent events).

**NAV geography — direct answer to the brief's question.** Yes, NAV appointments expose
geography/site relationships that could later become useful evidence. A NAV permits a
company to provide services to a **specific geographic area instead of the existing
appointed company** **[SEARCH-DISCOVERED]**. Each appointment therefore evidences:

```
NAV company ──appointed-for──▶ geographic area ──displacing──▶ incumbent undertaker
```

Three cautions:
1. This is **site/appointment** evidence, not a supplier relationship. It must not enter
   the supplier graph.
2. **Appointments are not organisations.** One NAV company holds many. Row count and
   organisation count will differ substantially — both **UNKNOWN**.
3. Ofwat's licensing policy for NAVs was updated in **May 2026**, with near-final policy
   published March 2026 **[SEARCH-DISCOVERED]**, so the register's shape may be in
   transition.

**Sewerage undertakers** are distinguishable from water undertakers via the appointment
type. Note that REG-UTIL-001 §4 recorded sewerage's NIS scope as UNRESOLVED — irrelevant
here (this is population acquisition, not regulatory scope), but relevant to any later
cohort labelled by regulatory status.

**WSSL holders are retail licensees**, classified `WATER_WSSL`, and must never be counted
as infrastructure operators. Ofwat separately publishes **refused** WSSL applications
**[SEARCH-DISCOVERED]** — refused applicants are **not licensees** and must be excluded at
the adapter, not filtered downstream.

---

## 7. Communications findings

- **The right statutory population is Code operators.** Code powers attach to providers of
  electronic communications networks and providers of infrastructure supporting such
  networks **[SEARCH-DISCOVERED]** — precisely the infrastructure filter this cohort wants,
  and much better targeted than a general communications-provider list.
- **The register is the least machine-readable source in the census**: HTML with A–Z
  buttons, no bulk download **[SEARCH-DISCOVERED]**.
- **Identity quality is likely poor** — no company number observed, no evident operator
  identifier. Resolution will rest on name matching, which is the weakest link in the
  precedence chain.
- **Tower, fibre and submarine cable operators**: to the extent they hold Code powers they
  appear in this register. A separate submarine-cable infrastructure register was **not
  identified** — **UNRESOLVED** (§23).

**Regulatory firewall.** REG-UTIL-001 §5 established that PECN/PECS providers cannot be
designated OES under reg. 8(1A) and are regulated under Communications Act ss.105A–105D.
**Nothing in this package changes, strengthens or weakens that.** Communications
organisations are acquired here as an **infrastructure population**, and any cohort
membership must be labelled by *sector*, never by implied NIS status. Mixing the two would
operationalise a regulatory conclusion this package is explicitly forbidden to touch.

---

## 8. Identity-quality assessment

### 8.1 The precedence chain, as implemented

From `organisation/identity.js` (`primaryKeyOf`), verified by inspection:

```
companiesHouseNumber → frn → sraNumber → frcAudit → hmrcAml → pbsFirm
  → ukprn → ifUuid → lei → nd:sha(normalisedName | domain)
```

Two observations decide the whole acquisition design:

1. **Companies House number is first.** Any source carrying it resolves deterministically
   at the strongest available tier, with no ambiguity and no domain.
2. **No utilities identifier is in the chain.** Ofgem licence numbers, Ofwat appointments,
   Ofcom Code-operator status and Elexon MPIDs are all absent. A source carrying only
   those falls through to `nd:sha(normalisedName|domain)` — the keyless fallback.

### 8.2 Source ranking by identity quality

| Tier | Sources | Resolution |
|---|---|---|
| **A — strong identifier present** | Ofgem electricity licensees (company number apparent) | Direct `cn:` key. Highest quality achievable. |
| **B — strong identifier probable** | Ofgem gas licensees; FTS OCDS parties | Company number may be present per-record; **UNKNOWN** until retrieved. |
| **C — name-based, high-quality names** | Ofwat licences/NAV/WSSL; Ofcom ECC register | Published legal names from a statutory register; good match candidates against Companies House, but a match, not a key. |
| **D — name-based, weaker names** | Elexon parties; NESO CMR; EA registers | Operating/trading names likely; higher ambiguity. |

### 8.3 Do NOT extend the precedence chain in this programme

A tempting move is to admit `ofgemLicence` or `ofwatAppointment` as strong identifiers.
**This package recommends against it**, for three reasons:

1. It requires a governance disposition equivalent to GCN-004 (which added FRC/HMRC/PBS
   and moved LEI). That is a Founder-level act, not an acquisition decision.
2. Changing `primaryKeyOf` risks changing existing `ORG-` ids — GCN-004 §H's explicit
   constraint is to preserve all existing organisation IDs unchanged.
3. **It is unnecessary.** If the electricity list carries company numbers, Tier A is
   already reached. For Tiers C/D, a licence number would not help resolution anyway —
   it identifies the *licence*, not the company, and cannot be matched against Companies
   House.

**Correct home for utilities identifiers:** the Organisation contract's `identifiers[]`
array (`{scheme, value, primary?}`) and `regulators[]` array
(`{regulator, identifier, status}`), both of which already exist in
`organisation/schema.js`. They can carry `ofgem-licence`, `ofwat-appointment`,
`elexon-mpid`, `ofcom-code-operator` **without touching identity precedence at all**.
This is the single most important identity recommendation in the package.

### 8.4 Identity complications and required handling

| Complication | Risk | Required acquisition behaviour |
|---|---|---|
| **Trading names** | Ofgem/Elexon/EA may publish operating rather than registered names | Preserve the name **exactly as observed** in a source-name field; never normalise in place |
| **Group companies** | "SSE", "National Grid", "Severn Trent" span many licensed entities | Never merge on brand. Resolve per legal entity |
| **Licence-holder subsidiaries** | IDNO/iGT affiliates of existing licensees **[SEARCH-DISCOVERED]** | Each licensed entity is its own organisation; group linkage is a later `Relationship`, not a merge |
| **One organisation, multiple licences** | Same entity holds supply + generation + distribution | One organisation, **many role records**. Role is evidence-scoped |
| **Cross-sector (elec + gas)** | Same entity in both Ofgem lists | Deterministic union on company number; **never on name alone**, and **never on domain** — the authority build's existing "never merge by shared domain" rule applies with equal force |
| **Licence transfers** | Licence moves between entities | Retain both source records with their dates; supersession is a lifecycle event, not a deletion |
| **Dormant / revoked licences** | Entity remains listed or disappears | Retain with status; **never delete**. `lifecycle.status` and `supersededBy` already exist in the schema |
| **Historic licence holders** | Absent from current lists | Preserved by append-only acquisition across reissues; a diff of two dated lists is itself evidence |
| **Joint ventures** | OFTOs and interconnectors are commonly JVs | The licensed JV entity is the organisation. Parent linkage is a `Relationship`, never a merge |
| **Refused applicants** | Ofwat publishes refused WSSL applications **[SEARCH-DISCOVERED]** | **Exclude at the adapter.** Never acquired as licensees |

### 8.5 The governing rule

> **Preserve source identity; defer collapse.**

Acquisition should record what each source said about each entity, with its own
identifiers and its own name, and resolve to a canonical `ORG-` id **only through the
existing precedence**. Where the precedence cannot decide, the organisation is retained as
unresolved (§17) rather than merged on a guess. This mirrors the authority build's
existing discipline — merge by strong identifiers only, never by shared domain — and
extends it to utilities without changing it.

---

## 9. Procurement / supplier graph assessment

### 9.1 Can authoritative buyer → supplier relationships be derived systematically?

**Yes, for organisations that publish procurement notices — with two structural limits
that must be stated plainly.**

The mechanism is sound: OCDS models buyer and supplier as distinct parties on a contract
award, with a stable notice/OCID identifier, published by a primary government source
**[SEARCH-DISCOVERED]**. That is genuine, citable, buyer→supplier evidence of exactly the
kind the target model needs.

**Limit 1 — coverage is a function of procurement obligation, not of importance.** Which
utilities operators publish to FTS depends on their status under the procurement regime.
Privately-owned utilities operating in the utilities sector have historically had
distinct (and narrower) obligations from public bodies. **The proportion of the operator
spine that appears as a buyer in FTS is UNKNOWN** and is a first-order question for
UTIL-05. A supplier graph covering a minority of the spine is still valuable — but must
not be presented as sector coverage.

**Limit 2 — the 2025 regime change.** FTS/CDP went live 24 February 2025
**[SEARCH-DISCOVERED]**. Notice types, party modelling and supplier-identifier practice
differ across that boundary. Any relationship built from a pre-2025 notice and one built
from a post-2025 notice are **not the same evidence class** and should be distinguishable
in provenance.

### 9.2 Field availability

From OCDS structure and the FTS/Contracts Finder implementation guidance
**[SEARCH-DISCOVERED]**. Per-notice presence is **UNKNOWN** until retrieval — OCDS makes
most fields optional, and publisher practice varies.

| Field | Expected availability | Note |
|---|---|---|
| Buyer identity (name) | **YES** | Core OCDS party |
| Buyer identifier / company number | **PARTIAL** | Scheme-dependent |
| Supplier identity (name) | **YES** (on awards) | Core OCDS party |
| Supplier company number | **PARTIAL** | The key unknown for supplier-side identity quality |
| Notice ID / OCID | **YES** | Stable relationship identifier |
| Contract / framework title | **YES** | |
| Award date | **YES** | Core temporal anchor |
| Contract value | **PARTIAL** | Commonly present; may be redacted or ranged |
| CPV classification | **YES (expected)** | Enables the secondary recall net (§10) |
| Contract description | **PARTIAL** | Free text; useful for classification, never for identity |
| Lot | **PARTIAL** | Matters for multi-lot frameworks — a supplier may win one lot only |
| Supplier status (awarded vs bidder) | **YES — derivable from notice type** | **Decisive**: only awarded suppliers become relationships (§11) |
| Framework / DPS membership | **PARTIAL** | Appointment ≠ call-off (§11) |
| Geographic information | **PARTIAL** | NUTS/place of performance |
| Contract start / end dates | **PARTIAL** | Drives CURRENT/HISTORICAL (§12) |

### 9.3 Utility-specific procurement portals

Many large operators run their own supplier portals. These were **not investigated for
access** and are generally **authentication-gated**, placing them outside a read-only
public-source acquisition. **Recommendation: exclude.** Where an operator publishes a
contracts register openly, that is a `CONFIRMED_CONTRACT` source (§11) — but it must be
evidenced per-operator, not assumed.

---

## 10. Buyer-seeded acquisition recommendation

**Recommendation: Option C — Hybrid, with buyer-seeding as the primary mechanism and CPV
as a strictly secondary recall net.**

### 10.1 Assessment of the three options

| Option | Strengths | Fatal weaknesses | Verdict |
|---|---|---|---|
| **A — Global procurement scrape** then classify buyers | Maximum recall; single acquisition path | Acquires an enormous volume of irrelevant notices; buyer classification becomes an **inference step**, and an inferred buyer classification is exactly the kind of anonymous derived fact §21 forbids; unbounded scale with no evidential gain | **Rejected** |
| **B — Pure buyer-seeded** | Every relationship anchored to a spine organisation; bounded, reproducible, highest evidence quality | Misses awards where the buyer's published name does not match the spine; misses relevant operators not in the spine | **Strong, but incomplete** |
| **C — Hybrid** | B's evidence quality, plus a CPV net that surfaces buyers the spine missed | Requires disciplined separation of the two outputs, or B's quality is diluted | **RECOMMENDED** |

### 10.2 The recommended design

```
UTIL-01..04 spine (authoritative operator organisations)
        │
        ├─ PRIMARY: buyer-seeded
        │    match spine organisations to OCDS buyer parties
        │    → award notices → CONFIRMED_AWARD relationships
        │
        └─ SECONDARY: CPV recall net
             selected utility CPV codes (water, electricity, gas,
             telecoms infrastructure)
             → buyers NOT already in the spine
             → PROCUREMENT_CANDIDATE only — never a relationship,
               never a cohort membership
```

**The discipline that makes the hybrid safe:** the two paths write **different evidence
classes**. Buyer-seeded output is `CONFIRMED_AWARD`. CPV-net output is a **candidate
organisation for spine review**, and produces no supplier relationship at all until its
buyer is resolved to the spine. The net improves recall of *operators*; it never
manufactures *relationships*.

This satisfies the brief's instruction to bias toward evidence quality and
reproducibility: the buyer-seeded path is fully reproducible from a fixed spine snapshot
plus a fixed FTS extract, and the CPV path cannot contaminate it.

---

## 11. Supplier relationship confidence model

**Design only. No implementation, no schema.**

### 11.1 Classes

| Class | Definition | Evidence required | Becomes a `SUPPLIED_BY` relationship? |
|---|---|---|---|
| **`CONFIRMED_AWARD`** | Supplier named in an official contract award notice | Award notice with buyer party, supplier party, OCID/notice id, award date | **YES — strongest** |
| **`CONFIRMED_FRAMEWORK`** | Supplier appointed to an official framework or DPS | Framework/DPS award notice naming the supplier (and lot where applicable) | **YES — qualified**: appointment, not proof of spend |
| **`CONFIRMED_CONTRACT`** | An operator's own published contract record names the supplier | Operator-published contracts register, publicly accessible | **YES** |
| **`PROCUREMENT_CANDIDATE`** | A notice indicates relevance but establishes no awarded relationship | Tender/opportunity notice, pre-award notice, CPV-net hit | **NO** |

### 11.2 Exclusion rules (mandatory)

1. **Unsuccessful bidders are never suppliers.** Where a notice names bidders as well as
   the awarded party, only the awarded party generates a relationship. A named
   unsuccessful bidder generates **nothing** — not even a candidate.
2. **Sector is never evidence.** That an organisation supplies "the water industry" is not
   evidence that it supplies *any particular undertaker*. No relationship may be created
   from sector, industry description, marketing material, or CPV code alone.
3. **Framework appointment is not a contract.** `CONFIRMED_FRAMEWORK` means eligible to be
   called off, not that anything was. It must remain distinguishable from
   `CONFIRMED_AWARD` for ever — collapsing them would inflate the supplier graph with
   relationships that never transacted.
4. **A candidate never silently graduates.** Promotion from `PROCUREMENT_CANDIDATE`
   requires new award evidence, recorded as its own source record.

### 11.3 Multi-party awards

Where an award names several suppliers (multi-lot, consortium, multi-supplier framework),
each generates a **separate** relationship with its own evidence, carrying the lot
identifier where present. Consortium members should each be recorded rather than
collapsed into a lead supplier — collapsing loses exactly the multi-operator supplier
nodes §19 identifies as strategically interesting.

---

## 12. Temporal relationship model

### 12.1 Available temporal evidence

| Evidence | Source | Availability |
|---|---|---|
| Award date | OCDS award | **Expected YES** |
| Notice publication date | OCDS release | **Expected YES** |
| Contract start / end date | OCDS contract period | **PARTIAL** |
| Framework duration | Framework notice | **PARTIAL** |
| Licence/appointment grant date | Ofgem/Ofwat registers | **UNKNOWN** |
| Party entry/exit dates | Elexon monthly change articles **[SEARCH-DISCOVERED]** | **YES — unusually good** |
| Source snapshot date | Dated artefacts (e.g. licensee list versions) | **YES** — a diff across dated lists is itself temporal evidence |

### 12.2 Recommended state derivation

Three states, **derived at read time from retained evidence — never stored as a mutable
flag, and never by deleting anything**:

| State | Condition |
|---|---|
| **`CURRENT`** | Contract/framework end date is in the future, **or** the relationship appears in the most recent acquisition snapshot of a live register |
| **`HISTORICAL`** | End date is in the past, **or** the relationship appeared in an earlier snapshot and not in the current one |
| **`UNKNOWN`** | No end date and no snapshot basis for deciding — **the honest default** |

**`UNKNOWN` must be the default**, not `CURRENT`. Contract periods are only partially
available (§9.2); defaulting to `CURRENT` would assert currency the evidence does not
support. This is the temporal equivalent of the observation layer's distinction between
`OBSERVED_ABSENT` and `NOT_OBSERVED` — a distinction this repository already enforces
rigorously in signal collection, and which should carry over unchanged.

### 12.3 Retention rule

> **An expired contract remains evidence that a supplier relationship existed.**

Expiry changes a relationship's *state*, never its *existence*. Nothing is deleted.
A supplier that held a five-year contract with a network operator ending last year is
still a supplier that had privileged access to that operator — historically material, and
precisely the sort of fact a naive "current suppliers only" model destroys.

Practically: append-only relationship evidence, with state derived. The repository's
existing append-only conventions (immutable raw evidence, regenerable derived views)
already model this correctly.

---

## 13. Environment Agency candidate layer

### 13.1 Classification: CANDIDATE-GENERATION ONLY

**Permit holder ≠ critical infrastructure organisation**, and this must be enforced
structurally, not by convention. EA registers cover installations, discharges to water and
groundwater, and waste operations **[SEARCH-DISCOVERED]** — populations dominated by
manufacturers, farms, waste handlers and industrial sites with no infrastructure role.

### 13.2 Relevant register categories

| Register | Relevance | Class |
|---|---|---|
| Water discharge / groundwater | Sewage treatment works operated by undertakers | **CANDIDATE** — corroborates known undertakers; rarely reveals new ones |
| Installations | Large industrial/energy installations | **CANDIDATE** |
| Waste operations | Waste infrastructure, energy-from-waste | **CANDIDATE** |
| Others | UNKNOWN — full register list not enumerated | **UNRESOLVED** |

### 13.3 Assessment

| Dimension | Finding |
|---|---|
| Bulk availability | **YES (at least partially)** — complete-register zip download for waste operations **[SEARCH-DISCOVERED]** |
| Record volumes | **UNKNOWN** — expected large, with heavy operator↔site multiplicity |
| Organisation identifiers | **UNKNOWN — assume none**; permit numbers identify permits, not companies |
| Operator names | **YES** — as permitted, likely operating names |
| Site/facility relationships | **YES** — permits are site-based; the layer's genuine strength |
| Permit categories | **YES** |
| Suitability | **MEDIUM, as a candidate layer only** |

### 13.4 Required handling

1. EA-derived organisations enter as **candidates**, never as cohort members.
2. An EA record may **corroborate** a spine organisation (adding site evidence) — that is
   its highest-value use.
3. An EA record alone **never** establishes an infrastructure role.
4. Site-level evidence is retained as site evidence, distinct from both regulatory
   membership and supplier relationships.
5. **Acquire last** (§16). Its volume-to-value ratio is the worst in the census, and it
   risks flooding the cohort with unresolvable names if run early.

---

## 14. Other public sources

Assessed against the brief's instruction to include only sources that materially improve
organisation or relationship evidence, and to avoid broad company directories.

| Source | Verdict | Rationale |
|---|---|---|
| **NESO Data Portal** (3.8) | **INCLUDE — enumerate first** | Primary publisher, CSV, likely several organisation-bearing registers |
| **NESO Capacity Market Register** (3.7) | **INCLUDE** | Best machine-readability in energy; populates generation/capacity class |
| **Elexon monthly BSC change articles** | **INCLUDE (temporal)** | Dated entries/exits — rare and valuable temporal evidence |
| **Ofgem "Registered or service addresses"** artefacts | **INCLUDE (enrichment)** | Address enrichment for licensees **[SEARCH-DISCOVERED]** |
| **DESNZ datasets** | **UNRESOLVED** | Not identified in this session; likely generation/infrastructure statistics rather than organisation registers |
| **DCC / smart-meter participant register** | **UNRESOLVED** | Not identified separately from the Ofgem licence class |
| **Embedded Capacity Registers (DNO-published)** | **UNRESOLVED** | Published per-DNO; format and organisation-bearing content unknown |
| **Energy code participant registers** (other than BSC) | **UNRESOLVED** | Other codes exist; not enumerated |
| **Statutory undertakers lists** (planning context) | **EXCLUDE for now** | Definition varies by statutory context; risks importing a different population under a similar name |
| **Companies House** (3.18) | **INCLUDE as substrate only** | Resolution and enrichment; **not** a utilities population |
| Generic company directories / vendor databases | **EXCLUDE** | Explicitly out of scope; no authority |

---

## 15. Deduplication / overlap considerations

### 15.1 Cross-cohort overlap is UNMEASURED — and the cohort list needs correcting

**No production read was attempted.** Per the brief's instruction, cross-cohort overlap is
therefore **UNMEASURED**.

Beyond that, repository inspection materially corrects the brief's premise. The
acquisition machinery and registries present in **this repository** are:

- **FCA** (`acquisition/acquire-fca.js`, `fca-adapters.js`, `acquisition/runs/fca/`)
- **SRA** (`derive-sra-registry.js`, `collection/sources/sra/`, `acquisition/runs/sra/`)
- **IF**, **PRA**, **HE** — named as legacy registries merged by the authority build
  (`authority/README.md`)

**No Defence/MOD, Rail, NHS or general Education population exists in this repository.**
Whether such populations exist elsewhere in the Soterius estate is outside what this
session can determine. Any overlap analysis naming them would be fabricated.

**Status: cross-cohort overlap UNMEASURED. Cohort inventory partially UNVERIFIABLE from
this repository.**

### 15.2 Structural overlap expectations (qualitative, not quantified)

| Pair | Expected overlap | Reasoning |
|---|---|---|
| Ofgem electricity ↔ Ofgem gas | **HIGH** | Dual-fuel groups hold both; resolvable on company number |
| Ofgem ↔ Elexon | **HIGH** | BSC parties are largely electricity licensees; name-based resolution |
| Ofgem ↔ NESO CMR | **MEDIUM** | Generators overlap with generation licensees |
| Ofwat ↔ Ofgem | **LOW** | Multi-utility groups exist but are the exception |
| Ofcom ↔ energy/water | **VERY LOW** | Structurally different populations |
| Procurement suppliers ↔ operator spine | **LOW–MEDIUM** | Operators occasionally supply each other — and such cases are **strategically interesting**, not noise (§19) |
| EA candidates ↔ everything | **UNKNOWN** | Large, name-only, unresolvable without retrieval |
| Utilities ↔ FCA/SRA/HE | **EXPECTED LOW** | Regulated-finance, legal and HE populations are structurally distinct |
| **Utilities suppliers ↔ any existing cohort** | **UNKNOWN — potentially the largest overlap in the programme** | Suppliers are ordinary UK companies; a construction or IT firm could plausibly appear in several cohorts |

### 15.3 Net-new coverage assessment

- **Operator spine: expected HIGH net-new.** Utility licensees are not finance, law or HE
  organisations. Almost certainly new to this repository's canonical dataset. **UNMEASURED.**
- **Supplier graph: net-new UNKNOWN, and the honest answer must stay UNKNOWN.** Suppliers
  are general UK companies; overlap with any existing supplier-side population cannot be
  guessed. Its distinct value is arguably the **relationships**, which are new regardless
  of whether the organisations are.

---

## 16. Proposed acquisition layers

Reordered from the brief's candidate structure, with reasons. Two changes: **water is
promoted above gas**, and **communications is deferred below the first supplier layer**.

| Layer | Name | Source(s) | Evidence quality | Scale | Identity quality | Difficulty | Net-new value | Depends on |
|---|---|---|---|---|---|---|---|---|
| **UTIL-01** | **Electricity operator spine** | Ofgem electricity licensees (3.2), EPR verification (3.1) | **HIGH** | UNKNOWN | **HIGH** (company number apparent) | **LOW–MEDIUM** (PDF extraction) | **HIGH** | — |
| **UTIL-02** | **Water operator spine** | Ofwat licences (3.9), NAV register (3.10), WSSL (3.11) | **HIGH** (best authority) | UNKNOWN (small) | **MEDIUM** (name-based) | **MEDIUM** (poor formats, small N) | **HIGH** | — |
| **UTIL-03** | **Gas operator spine** | Ofgem gas licensees (3.3) | **HIGH** | UNKNOWN | **MEDIUM–HIGH** (company number unconfirmed) | **LOW–MEDIUM** (same adapter as UTIL-01) | **MEDIUM** (overlaps UTIL-01) | UTIL-01 (adapter reuse) |
| **UTIL-04** | **Electricity market-role overlay** | Elexon BSC (3.5), monthly change articles | **MEDIUM** | UNKNOWN | **LOW–MEDIUM** | **MEDIUM** | **MEDIUM** (roles + temporal) | UTIL-01 |
| **UTIL-05** | **Generation / capacity layer** | NESO CMR (3.7), NESO portal (3.8) | **MEDIUM–HIGH** | UNKNOWN (unit rows ≫ orgs) | **LOW–MEDIUM** | **LOW** (clean CSV) | **MEDIUM** | UTIL-01 |
| **UTIL-06** | **Supplier graph — energy & water** | FTS OCDS (3.13) via OCP mirror (3.14) | **HIGH** | UNKNOWN | **MEDIUM** | **HIGH** | **VERY HIGH** (relationships) | UTIL-01/02/03 |
| **UTIL-07** | **Communications infrastructure spine** | Ofcom ECC register (3.12) | **MEDIUM–HIGH** | UNKNOWN | **LOW** | **HIGH** (no bulk, no numbers) | **MEDIUM** | — |
| **UTIL-08** | **Supplier graph — communications + historic/devolved** | FTS, Contracts Finder (3.15), devolved portals (3.16) | **MEDIUM–HIGH** | UNKNOWN | **MEDIUM** | **HIGH** | **MEDIUM** | UTIL-06, UTIL-07 |
| **UTIL-09** | **Environment/infrastructure candidate expansion** | EA registers (3.17) | **LOW (candidate)** | UNKNOWN (large) | **LOW** | **MEDIUM** | **LOW–MEDIUM** | UTIL-01/02/03 |

### 16.1 Why the reordering

- **Water above gas.** Water has the cleanest authority (Instruments of Appointment, no
  disclaimer problem), a small stable population, and no overlap with UTIL-01 — so it adds
  net-new organisations immediately. Gas overlaps electricity heavily and reuses UTIL-01's
  adapter, so it is cheaper *after* UTIL-01 and adds less that is new.
- **Communications deferred to UTIL-07.** It is the hardest layer (no bulk, no download, no
  company numbers) and the most isolated. Doing it early spends the most engineering for
  the least resolvable identity.
- **Supplier graph at UTIL-06, not later.** Once three spines exist, the supplier graph is
  the highest-value remaining work and the only layer producing genuinely new *relationship*
  evidence.
- **EA last, unchanged.** Worst volume-to-value ratio; benefits from every prior layer
  being available for corroboration.

---

## 17. Domain-independent acquisition design

### 17.1 Why this works cleanly here

Domain independence is not a workaround in this repository — it falls out of the identity
model. `primaryKeyOf()` consults `domain` **only** in the keyless fallback
`nd:sha(normalisedName|domain)`. An organisation with a Companies House number gets a
stable canonical id with `domain` never read.

Only one case is domain-sensitive: an organisation with **no strong identifier at all**.
There, the fallback degrades to a name-only hash — deterministic, but weaker and
collision-prone (the authority build applies collision suffixes batch-only). That is a
known, bounded weakness, and the correct response is to retain the organisation as
unresolved, **not** to go looking for a domain to strengthen the key.

### 17.2 Proposed acquisition states

Expressed against concepts already in `organisation/schema.js` — no new schema.

| State | Meaning | Canonical expression |
|---|---|---|
| **`IDENTITY_RESOLVED_NO_DOMAIN`** | Strong identifier present; canonical id assigned; `domains: []` | The **expected majority** for the spine |
| **`IDENTITY_RESOLVED_DOMAIN_ALREADY_KNOWN`** | Strong identifier present; a domain already exists in canonical data | Existing `domains[]` entries retained untouched — **no new domain is sought** |
| **`IDENTITY_UNRESOLVED`** | No strong identifier; name-only fallback; ambiguity unresolved | Retained with source evidence and `lifecycle.status`; **never discarded** |

### 17.3 Prohibitions for this programme

- **No domain discovery.** No search, no inference, no guessing from names.
- **No DNS lookups** of any kind.
- **No website inference** from organisation names or addresses.
- **No enrolment in monitoring.** Acquisition produces organisations and evidence; it does
  not create observation subjects.
- **No discarding for lack of domain.** A domainless organisation is a complete, valid
  acquisition outcome.

### 17.4 Consistency with the MOD approach

The brief states this follows the strategy used for MOD: acquire the organisation/evidence
graph first, resolve domains independently later. That sequencing is what makes the
package safe — **the entire acquisition can complete, be reviewed and be ratified without
a single domain being touched**, and domain resolution becomes a separate, separately
governed programme against an already-stable set of canonical organisation ids.

---

## 18. Scale assessment

### 18.1 Measured figures

| Metric | Value |
|---|---|
| Source rows | **UNKNOWN** |
| Unique legal entities | **UNKNOWN** |
| Duplicate identities | **UNKNOWN** |
| Active entities | **UNKNOWN** |
| Historic / inactive entities | **UNKNOWN** |
| Buyer counts | **UNKNOWN** |
| Awarded supplier counts | **UNKNOWN** |
| Unique buyer→supplier relationships | **UNKNOWN** |
| Identifiable Companies House numbers | **UNKNOWN** |

**Every figure is UNKNOWN because no source was retrieved.** No `EXACT` or
`OBSERVED_MINIMUM` value can be offered — an `OBSERVED_MINIMUM` still requires an
observation, and there were none.

### 18.2 Band assessment

**The brief asks whether the eventual Utilities population is hundreds, low thousands,
several thousands or tens of thousands. This package states NO BAND.**

The evidence does not permit one. Stating a band from model knowledge would be exactly the
"fake precision" the brief prohibits, and it would be the most quotable — and most
dangerous — number in the document.

What *can* be said structurally, without numbers:

- The **operator spine** is bounded by licence and appointment counts, which are small
  relative to the supplier graph. It is the smaller population by a wide margin.
- The **supplier graph** is bounded by award-notice volume across the spine, and is
  expected to be substantially larger than the spine — but "substantially" is not a
  quantity.
- The **EA candidate layer** would be the largest by row count and the least useful per
  row.
- **Rows ≠ organisations** in at least four sources (NAV appointments, NESO CMU rows, EA
  site permits, OCDS multi-party awards). Any count taken before deduplication will
  overstate organisations, in some cases severely.

### 18.3 What would settle it

**One retrieval settles the spine band:** the Ofgem electricity licensee list (3.2).
It is a single bulk document containing the sector-complete licensee population with role
and, apparently, company number. Retrieving and parsing it yields `EXACT` values for
source rows, unique entities and company-number coverage in one step — and that alone
would move UTIL-01 from designed to measured.

For the supplier graph, an all-time OCP mirror extract (3.14) filtered to resolved spine
buyers would yield `EXACT` buyer, supplier and relationship counts.

---

## 19. Interesting subcohorts

Technically useful subsets, **with no willingness-to-pay asserted** — these are structural
observations about the graph, not market claims.

| Subcohort | Definition | Derivable from | Interest |
|---|---|---|---|
| **Critical electricity network operators** | `ELEC_TRANSMISSION_*`, `ELEC_DISTRIBUTION_DNO`, `ELEC_SYSTEM_OPERATOR`, `ELEC_INTERCONNECTOR` | UTIL-01 role field | The core infrastructure population |
| **Gas network operators** | `GAS_TRANSMISSION_NTS`, `GAS_DISTRIBUTION_GDN`, `GAS_INTERCONNECTOR` | UTIL-03 | Core, excludes shippers/suppliers |
| **Water & sewerage undertakers** | `WATER_UNDERTAKER`, `SEWERAGE_UNDERTAKER`, `WATER_AND_SEWERAGE_UNDERTAKER` | UTIL-02 | Small, stable, highest authority |
| **Independent network operators** | `ELEC_DISTRIBUTION_IDNO`, `GAS_TRANSPORTER_INDEPENDENT`, `WATER_NAV` | UTIL-01/02/03 | Structurally distinct: smaller, growing, affiliate-heavy |
| **Telecom infrastructure operators** | `COMMS_CODE_OPERATOR` | UTIL-07 | Statutory infrastructure filter |
| **Electricity infrastructure suppliers** | Suppliers with `CONFIRMED_AWARD` to electricity network operators | UTIL-06 | Direct dependency evidence |
| **Water infrastructure suppliers** | Suppliers with `CONFIRMED_AWARD` to undertakers | UTIL-06 | As above |
| **Multi-utility suppliers** | Suppliers with awards to operators in **≥2 utility sectors** | UTIL-06 | Concentration nodes |
| **Suppliers to multiple regulated operators** | Suppliers with awards to **≥2 distinct operators** | UTIL-06 | Concentration within a sector |
| **Current / high-value contract suppliers** | Relationship state `CURRENT` **and** value above a threshold | UTIL-06 + §12 | Depends on value-field availability (**PARTIAL**) |
| **Cross-CNI-sector suppliers** ⭐ | Suppliers appearing across **utilities and other critical-infrastructure cohorts** | UTIL-06 + cross-cohort join | **Flagged as strategically important** |

### 19.1 The flagged subcohort

The brief asks to especially flag organisations supplying more than one critical
infrastructure operator or sector. Two honest observations:

- **Within utilities, this is derivable** once UTIL-06 exists: count distinct operators
  and distinct sectors per supplier. It requires no new data beyond the supplier graph and
  is one of the few genuinely novel structures this cohort would produce.
- **Across critical-infrastructure sectors, it is currently NOT derivable from this
  repository.** It requires other CNI cohorts to exist here, and §15.1 establishes that
  Defence, Rail and NHS populations are **not present**. The cross-sector version of this
  subcohort is therefore **blocked on cohort availability, not on utilities acquisition**.

The distinction matters: the intra-utilities version is a deliverable of UTIL-06; the
cross-sector version is an aspiration contingent on populations this repository does not
hold.

---

## 20. Canonical-model fit

### 20.1 What actually exists in this repository

The brief asks to map into a ten-object model and specifies "no new schema". Repository
inspection shows the ten objects are **not all realised here**, and this must be reported
rather than assumed:

| Object | Status in this repository |
|---|---|
| **Organisation** | **EXISTS** — `organisation/schema.js`, ADR-SYS-010 contract |
| **Domain** | **EXISTS** — `Organisation.domains[]`; signal tables keyed by domain |
| **Attribution** | **NOT FOUND** — no implementation located |
| **Cohort** | **EXISTS** — `cohorts` table (migration 004a) |
| **Membership** | **MISMATCH** — `memberships` (migration 024) is **customer↔user tenancy**, enforcing one tenant per user (ADR-SYS-007 §3.2). It is **not** organisation↔cohort membership |
| **Relationship** | **NOT FOUND** — no organisation↔organisation relationship implementation |
| **Source** | **PARTIAL** — expressed as `Provenance[]` on Organisation (`section`, `source`, `observedAt`, `retrievedAt`, `confidence`), not as a standalone object |
| **Scan** | **EXISTS** — `scans` table (migration 001) |
| **Evidence** | **PARTIAL** — observation envelopes and signal fact tables serve this role for signals |
| **Score** | **PARTIAL** — `signal_quality_*` tables; explicitly separated from collection |

**The central object for this programme — `Relationship` — does not exist.** Any eventual
implementation of the supplier graph requires either a new schema object (which needs
governance authorisation) or an ADR-level decision to express relationships within the
existing Organisation contract. **This package recommends only; it proposes no schema and
takes no position on which route is correct.**

### 20.2 Proposed mapping (recommendation only)

**Regulatory membership evidence:**

```
Organisation "ORG-<hash of cn:12345678>"
  identifiers[]  { scheme: "companies-house", value: "12345678", primary: true }
                 { scheme: "ofgem-licence",   value: "<licence ref>" }
  regulators[]   { regulator: "ofgem", identifier: "<licence ref>", status: "active" }
  classification[] (append-only, timestamped) → role: ELEC_DISTRIBUTION_DNO
  provenance[]   { section: "regulators[0]",
                   source: "ofgem-electricity-licensee-list",
                   observedAt: "<list publication date>",
                   retrievedAt: "<acquisition timestamp>",
                   confidence: "corroborated" }   ← NOT "verified" (see §4.2)

Organisation → Cohort membership
  Cohort: cohort_code "UTIL-ELEC", sector "Utilities / Electricity",
          data_sources ["ofgem-electricity-licensee-list"]
```

**Procurement relationship evidence (requires the missing object):**

```
Organisation A (buyer, spine)
  → Relationship { type: "SUPPLIED_BY",
                   counterparty: Organisation B,
                   evidence_class: "CONFIRMED_AWARD",
                   temporal_state: "CURRENT" | "HISTORICAL" | "UNKNOWN",
                   award_date, contract_start, contract_end, lot, value, cpv }
  → Source       { publisher: "Find a Tender Service",
                   record_id: "<OCID / notice id>",
                   url: "<notice url>",
                   source_date: "<publication date>",
                   retrieval_channel: "OCP mirror (secondary)",
                   retrievedAt: "<timestamp>" }
```

### 20.3 The distinction that must be preserved

> **Regulatory membership evidence** and **procurement relationship evidence** are
> different classes of fact and must never share a representation.

- *"Organisation A holds an Ofgem electricity distribution licence"* — a **register
  fact**, verifiable against a statutory publication, true or false.
- *"Organisation B was named as awarded supplier to Organisation A in notice X"* — a
  **relationship fact**, true of a specific notice at a specific date, and carrying a
  temporal state that changes.

They differ in publisher, in permanence, in cardinality and in what they license anyone to
conclude. This mirrors the FACT/INTERPRETATION separation REG-UTIL-001 §16 required for
regulatory interpretation — a different axis, same discipline: **do not let two kinds of
claim inherit each other's epistemic status.**

---

## 21. Provenance requirements

Every acquired fact must remain traceable. Minimum retained fields:

| Field | Requirement | Existing home |
|---|---|---|
| **Publisher** | Ofgem / Ofwat / Ofcom / Elexon / NESO / FTS / EA | `Provenance.source` |
| **Source URL** | Canonical URL of the artefact | Provenance extension |
| **Source record identifier** | Licence ref, appointment ref, MPID, CMU id, OCID/notice id, permit number | `identifiers[]` / relationship evidence |
| **Source date** | The source's own publication/observation date | `Provenance.observedAt` |
| **Acquisition timestamp** | When Soterius retrieved it | `Provenance.retrievedAt` |
| **Legal / registered name as observed** | Verbatim, unnormalised | Source-name field on the legal entity |
| **Regulator / market identifier** | Where present | `regulators[]` |
| **Relationship evidence** | Notice id, award date, evidence class, lot | Relationship evidence (object missing — §20.1) |
| **Confidence** | `verified` / `corroborated` / `inferred` | `Provenance.confidence` |
| **Retrieval channel** | Where a mirror was used instead of the primary | **New provenance field recommended** |

### 21.1 Two non-negotiables

1. **No anonymous derived supplier relationships.** Every `SUPPLIED_BY` must resolve to a
   named notice from a named publisher with a retrievable identifier. A relationship whose
   provenance is "derived from procurement analysis" is **malformed** and must be
   rejected at write time, not cleaned up later.
2. **Mirrors never masquerade as primaries.** Where the OCP mirror (3.14) supplies the
   bytes, the publisher remains Find a Tender and the mirror is recorded as the retrieval
   channel, with its weekly lag noted. This is why `retrieval_channel` is recommended as a
   distinct field rather than being folded into `source`.

### 21.2 Confidence discipline

The `verified` / `corroborated` / `inferred` values already in the schema map cleanly onto
this census's authority problem:

- `verified` — confirmed against the authoritative register (Ofgem EPR; Ofwat instrument)
- `corroborated` — from an authoritative publisher's non-authoritative artefact (the
  licensee lists, which Ofgem disclaims **[SEARCH-DISCOVERED]**)
- `inferred` — **not permitted for spine membership or supplier relationships in this
  programme**

That third rule is what keeps the cohort defensible: every spine membership and every
supplier relationship is either verified or corroborated against a named publication.
Nothing in this cohort is inferred.

---

## 22. Recommended first implementation package

### **UTIL-01 — Ofgem Electricity Operator Spine**

**Sources:** Ofgem "List of all electricity licensees including suppliers" (3.2) as the
acquisition artefact; Ofgem EPR (3.1) as the verification authority; Ofgem registered/service
address artefacts (§14) as optional enrichment; Companies House (3.18) as the existing
resolution substrate.

**Scope:** Acquire every electricity licensee as published, with licence type mapped to the
§2.2 role vocabulary, resolved to canonical `ORG-` ids via the existing precedence — with
**no domain involvement of any kind**.

**Why it should precede every other layer:**

1. **Best identity quality available anywhere in the census.** The observed structure
   `Licensee | Company No | Licence Type` **[SEARCH-DISCOVERED]** lands directly on
   `companiesHouseNumber` — first in `primaryKeyOf()`. No other source in the census
   plausibly reaches Tier A.
2. **Highest authority-per-unit-effort.** A single bulk document covers a sector-complete
   licensed population, with the disclaimer handled honestly through the existing
   `confidence: "corroborated"` mechanism (§4.2) rather than ignored.
3. **Lowest ambiguity.** Role comes from the source's own licence-type column — no
   classification inference, no judgement call, no derived category.
4. **Zero dependencies.** It depends on no other layer; every other layer benefits from it
   existing. UTIL-03 reuses its adapter; UTIL-04 and UTIL-05 resolve against it; UTIL-06
   cannot start without a spine to seed from.
5. **Lowest operational risk.** One document, one publisher, no API terms to clear (unlike
   Elexon BMRS, §3.6), no paging, no rate limits, no authentication.
6. **It settles the scale question.** Parsing it converts the spine band from `UNKNOWN` to
   `EXACT` in a single step (§18.3) — the most informative next action available.
7. **It exercises the full pattern once, cheaply.** Role vocabulary, provenance with
   confidence tiers, entity preservation over group collapse, and domain-free resolution
   are all tested on the easiest source before being applied to harder ones.

**Explicitly out of scope for UTIL-01:** any domain work; any monitoring enrolment; any
supplier/procurement acquisition; any schema change; any admission to production canonical
data; Elexon, NESO, Ofwat, Ofcom and EA sources.

**First action on unrestricted egress:** retrieve 3.2 and confirm (a) company-number
presence and coverage, (b) licence-type vocabulary as published, (c) exact row count. Those
three facts convert this design into an implementable specification.

**Not implemented. Recommendation only.**

---

## 23. Unresolved questions / inaccessible sources

### 23.1 Inaccessible sources

**All of them.** Every source in §3 has retrieval status `BLOCKED` or `SEARCH-DISCOVERED`;
none was retrieved or inspected. Hosts confirmed blocked this session: `ofgem.gov.uk`,
`ofwat.gov.uk`, `elexon.co.uk`, `find-tender.service.gov.uk`, `environment.data.gov.uk`,
`data.gov.uk`, plus `ofcom.org.uk`, `gov.uk`, `assets.publishing.service.gov.uk` and
`legislation.gov.uk` from earlier in the session. Not separately probed (assume blocked):
`epr.ofgem.gov.uk`, `neso.energy`, `data.open-contracting.org`,
`contractsfinder.service.gov.uk`, devolved portals.

### 23.2 Unresolved questions

| # | Question | Impact |
|---|---|---|
| 1 | Does the Ofgem electricity licensee list carry company numbers for **all** rows? | **Highest-impact unknown.** Determines whether UTIL-01 reaches Tier A identity |
| 2 | Does the Ofgem **gas** list carry company numbers? | Determines UTIL-03 identity quality |
| 3 | What is the exact licence-type vocabulary in each Ofgem list? | Determines the role mapping; §2.2 is provisional until confirmed |
| 4 | Are gas interconnectors and site-specific pipeline operators separately identifiable? | Completeness of the gas spine |
| 5 | Is there a separate DCC / smart-meter participant register? | Completeness of `ELEC_SMART_METER_COMMS` |
| 6 | What format is the Ofwat NAV register (PDF/XLSX/HTML)? | UTIL-02 difficulty |
| 7 | Do Ofwat sources carry company numbers? | UTIL-02 identity quality |
| 8 | Does the Ofcom ECC register carry any identifier beyond name? | UTIL-07 viability |
| 9 | **What proportion of the operator spine appears as an FTS buyer?** | **Determines the supplier graph's coverage — the key UTIL-06 unknown** |
| 10 | Do FTS OCDS parties carry company numbers reliably? | Supplier-side identity quality |
| 11 | How do pre- and post-24-Feb-2025 notices differ structurally? | Whether one adapter or two are needed |
| 12 | Do devolved-portal notices duplicate into FTS? | Whether §3.16 sources are additive or duplicative |
| 13 | What are Elexon's BMRS/open-data licence terms? | Whether §3.6 is acquirable at all |
| 14 | Full enumeration of EA public registers | §13.2 completeness |
| 15 | Full enumeration of the NESO Data Portal | §14 completeness |
| 16 | **Does a `Relationship` object exist anywhere in the wider Soterius estate?** | **Determines whether UTIL-06 needs new schema and therefore governance** |
| 17 | Do Defence, Rail, NHS or Education populations exist outside this repository? | Whether the cross-CNI-sector subcohort (§19.1) is reachable |
| 18 | Cross-cohort overlap with existing FCA/SRA/IF/PRA/HE populations | **UNMEASURED** — requires a production read not attempted here |

---

## 24. Final question, answered

> **Can Soterius construct a large, defensible UK Utilities / Critical Infrastructure
> organisation-and-supplier graph from freely available authoritative public sources
> without doing domain discovery, and what is the highest-value first acquisition layer?**

**Yes to defensible. Yes to domain-free. "Large" is unproven and this package will not
pretend otherwise.**

**Defensible: yes.** Every layer proposed here rests on a statutory regulator, a code
administrator, a system operator, or the government procurement platform. Ofgem publishes
licensees with licence types; Ofwat holds the Instruments of Appointment; Ofcom maintains
the register of Code-powers holders; NESO publishes the Capacity Market Register as bulk
CSV; Find a Tender publishes contract awards as OCDS **[all SEARCH-DISCOVERED]**. Nothing
in the design requires an inference to establish either a regulatory role or a supplier
relationship — roles come from licence classes, relationships come from named award
notices, and everything else is retained as a candidate.

**Domain-free: yes, cleanly.** This is a property of the code, not an aspiration.
`primaryKeyOf()` resolves on Companies House number first and consults `domain` only in
the keyless fallback. If the Ofgem electricity list carries company numbers as its observed
structure suggests, the spine resolves at the strongest tier with domains never read. The
entire programme — spine, roles, supplier relationships, provenance — can complete without
a single DNS lookup, domain guess, or website inference, exactly as the MOD approach
intends.

**Large: unproven, and deliberately left so.** No source was retrieved, so every count is
`UNKNOWN` and no band is stated. Structurally the spine is bounded by licence and
appointment counts and the supplier graph is expected to be materially larger — but
"expected to be larger" is a shape, not a size, and the brief was right to forbid the
alternative.

**Highest-value first layer: UTIL-01, the Ofgem electricity operator spine.** It has the
best identity quality in the census, sector-complete coverage in one bulk artefact, roles
carried by the source itself, zero dependencies, the lowest operational risk, and it is the
seed every procurement layer requires. It also does the most to reduce uncertainty: parsing
that one document converts the spine's scale from `UNKNOWN` to `EXACT` and confirms or
refutes the company-number assumption on which the whole identity design rests.

**One caveat, stated plainly.** The supplier graph's central object — `Relationship` —
does not exist in this repository. UTIL-01 through UTIL-05 can proceed within the existing
canonical model. **UTIL-06 cannot**, without either a governance-authorised schema addition
or an ADR-level decision on how relationships are expressed. That is a decision to take
before UTIL-06 is planned, not during it.

---

*End of UTIL-ACQ-001. Research and design package only — not a governed authority, not
registered, not integrated, not implemented. No production system, canonical dataset,
schema, migration, admission, monitoring, scoring or scheduler configuration was modified.
No organisations were admitted. No domains were discovered, inferred or resolved. No DNS
lookups were performed. No scanning was performed. No pull request was created.*
