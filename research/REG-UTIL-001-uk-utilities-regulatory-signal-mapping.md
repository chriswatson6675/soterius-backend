# REG-UTIL-001 — UK Utilities Regulatory Boundary-Signal Mapping

**Package ID:** REG-UTIL-001 (SOTERIUS-UTILITIES-REGULATORY-BOUNDARY-SIGNAL-MAPPING-01)
**Status:** RESEARCH ONLY — **NOT a governed authority.** Not registered in `DOCUMENT_REGISTER.md`, not citable for conformance, not integrated into any production path.
**Research date:** 2026-09-03
**Scope:** Read-only. No code, schema, data, scheduler, scoring, admissions, cohort or monitoring change. No organisations or domains acquired. No scanning performed.
**Author:** Automated research pass, Soterius backend repository.

> ### ⚠️ MATERIAL EVIDENCE-ACCESS LIMITATION — READ FIRST
>
> **Direct retrieval of primary sources was blocked throughout this session.** The
> execution environment's egress policy blocked every authoritative host required by
> Stage 2, confirmed individually:
>
> | Host | Result |
> |---|---|
> | `www.legislation.gov.uk` | EGRESS_BLOCKED |
> | `www.ncsc.gov.uk` | EGRESS_BLOCKED |
> | `www.gov.uk` | EGRESS_BLOCKED |
> | `assets.publishing.service.gov.uk` | EGRESS_BLOCKED |
> | `www.ofgem.gov.uk` | EGRESS_BLOCKED |
> | `www.dwi.gov.uk` | EGRESS_BLOCKED |
> | `bills.parliament.uk` | EGRESS_BLOCKED |
>
> Only a **search index** was reachable. Consequently:
>
> 1. **No verbatim quotations are reproduced in this package.** Stage 2 requires a
>    "short quotation or tightly bounded extract" per conclusion. Rather than
>    fabricate quotations or dates to satisfy the template, every regulatory
>    proposition below is recorded as a **paraphrase** with an explicit
>    **evidence-provenance tag**. Fabricated citations would be far more damaging
>    than an acknowledged gap.
> 2. **Every statement carries one of two tags:**
>    - **`[S]` SEARCH-CORROBORATED** — the proposition was returned by a search over
>      the official domain in this session, and the official URL was captured. The
>      substance is corroborated; the *exact wording, section number and publication
>      date are not independently verified*.
>    - **`[M]` MODEL-KNOWLEDGE, UNVERIFIED** — asserted from model knowledge and
>      **not corroborated in this session**. Treat as a research lead requiring
>      verification, never as authority.
> 3. **Confidence ratings throughout are capped accordingly.** No row in the matrix
>    is rated HIGH confidence on regulatory wording, because no regulatory wording
>    was read.
>
> **This package is a defensible analytical framework and a verification worklist. It
> is not yet a citable regulatory evidence pack.** Section 17 lists the exact
> retrievals required to promote it. Do not put any claim from this document in front
> of a customer, insurer or regulator until §17 is discharged.

---

## 1. Executive summary

**Central finding.** Soterius can legitimately position its continuous external
boundary-signal monitoring as producing **evidence relevant to** UK utilities
NIS/CAF cyber-security and supply-chain assurance outcomes. It cannot position that
monitoring as compliance, assessment, certification, or proof of anything.

Eight conclusions carry the package:

1. **No UK utilities regulation mandates any Soterius signal individually.** The
   statutory duty is outcome-based: NIS Regulations 2018 reg. 10 requires
   "appropriate and proportionate technical and organisational measures" **[S]**. No
   named technical control appears. Every technology-specific claim ("DMARC is
   mandatory under NIS") is false and must be prohibited.

2. **The relationship class `DIRECT` is used for zero of the 14 areas.** This is the
   honest result of applying the brief's fail-closed rule. Nothing Soterius measures
   is explicitly required by name in any UK utilities instrument identified.

3. **The CAF is the operative assessment vehicle, but it is guidance made applicable
   by regulator practice — not statute.** Ofgem is joint Competent Authority with
   DESNZ (formerly BEIS) for downstream gas and electricity in GB and uses the CAF in
   its assessment approach, publishing a CAF Overlay for the sector **[S]**. The DWI
   has received an annual CAF return from each in-scope water company since 2018,
   against 39 contributing outcomes, "at the request of the DWI" **[S]**. This
   distinction — *regulator-adopted framework, not legal requirement* — must survive
   into every Soterius claim.

4. **Soterius's strongest ground is not email and not monitoring. It is asset and
   exposure management.** CAF A3 (Asset Management) requires that everything needed
   to deliver essential functions, including supporting infrastructure, is
   "determined and understood" **[S]**; CAF B4.d (Vulnerability Management) requires
   management of known vulnerabilities to prevent adverse impact on essential
   functions **[S]**. Knowing your internet-facing estate and its exposures is
   squarely within both.

5. **The single most useful corroborated fact for Soterius's commercial case is the
   NCSC's own withdrawal.** NCSC retired Web Check and Mail Check on 31 March 2026,
   stating that External Attack Surface Management products now perform "effectively
   the same function", and recommending organisations adopt a commercial EASM product
   **[S]**. The NCSC has vacated exactly Soterius's observation space and told the
   market to buy it. This is a market fact, **not** an endorsement of Soterius.

6. **Continuous monitoring must not be claimed against CAF C1/C2.** C1 concerns
   monitoring of the networks and information systems supporting essential functions
   — internal telemetry, logs, skilled analysis **[S]**. C2 was **renamed from
   "Proactive Security Event Discovery" to "Threat Hunting" in CAF v4.0 (released
   4 August 2025)** **[S]**, and concerns hunting beyond known IOCs. External posture
   observation is neither. Classified INDIRECT. *The brief's own terminology for C2
   is out of date — see §6.2.*

7. **Supply chain is the fastest-moving opportunity.** Ofgem consulted on
   *Supply Chain Security: Proposed Guidance* (June 2026; Stage 2 consultation closed
   26 June 2026, outcome due August 2026), including a supplier-criticality framework
   spanning supplier stability, access and influence, and impact and propagation
   **[S]**. Critically, that framework expressly states it is **not** intended to
   produce a single composite score or automated classification **[S]** — a direct
   constraint on how Soterius may present supplier data.

8. **The Cyber Security and Resilience Bill is NOT law as at 2026-09-03.** Introduced
   to the Commons 12 November 2025; Commons stages completed 16 June 2026; Lords
   second reading 14 July 2026; Lords Committee stage commencing 1 September 2026;
   Royal Assent expected later in 2026, with phased implementation via secondary
   legislation **[S]**. Its critical-supplier designation regime is **PROPOSED, NOT
   IN FORCE**, and must never be presented as a current obligation.

---

## 2. Regulatory landscape

### 2.1 Current law

| Instrument | Status | Note |
|---|---|---|
| Network and Information Systems Regulations 2018 (SI 2018/506) | **CURRENT LAW** | Principal UK NIS regime for OES and RDSPs **[S]** |
| NIS (Amendment) Regulations 2018 (SI 2018/629) | CURRENT LAW | Amending **[S]** |
| NIS (Amendment etc.) (EU Exit) Regulations 2019 (SI 2019/653 and SI 2019/1444) | CURRENT LAW | Post-exit amendments **[S]** |
| NIS (Amendment and Transitional Provision etc.) Regulations 2020 (SI 2020/1245) | CURRENT LAW | Amending **[S]** |
| Communications Act 2003 ss.105A–105D (as amended by Telecommunications (Security) Act 2021) | CURRENT LAW | Telecoms security duty — **separate regime**, see §5 **[S]** |
| Electronic Communications (Security Measures) Regulations 2022 (SI 2022/933) | CURRENT LAW | In force 1 October 2022 **[S]** |
| Cyber Security and Resilience (NIS) Bill | **PROPOSED — NOT IN FORCE** | See §12 **[S]** |

### 2.2 The core duty

NIS reg. 10 imposes on an OES a duty to take appropriate and proportionate technical
and organisational measures to manage risks to the security of the network and
information systems on which the essential service relies, and appropriate and
proportionate measures to prevent and minimise the impact of incidents, with a view
to ensuring continuity of the service **[S]**. The duty includes having regard to
state-of-the-art guidance and to relevant guidance issued by the competent authority
**[S]**.

**Interpretation.** This is a pure outcome duty. It names no protocol, no product and
no measurement. Therefore:

- No Soterius signal can be `DIRECT` against reg. 10.
- The route from a Soterius signal to a regulatory relationship runs **through**
  competent-authority guidance (Ofgem/DWI) and the CAF, never straight to statute.
- Because the duty is expressly *proportionate*, an operator may lawfully decline a
  control Soterius measures. **A Soterius "fail" is not a finding of non-compliance.**

### 2.3 Framework layer, and its legal weight

The CAF is NCSC guidance. It acquires regulatory force in the utilities sectors only
through competent-authority adoption:

- **Energy (GB downstream gas & electricity):** Ofgem uses the CAF as part of its
  assessment approach and has published a *NIS Supplementary Guidance and CAF Overlay
  for the DGE Sector* **[S]**. OES "must have regard to" Ofgem's NIS guidance for the
  purposes of the NIS Regulations **[S]**.
- **Water (England & Wales):** the sector uses the CAF at the request of the DWI, with
  an annual CAF return against 39 contributing outcomes **[S]**.

**Label discipline (mandatory in all Soterius output):** CAF is *regulator-adopted
guidance*, not legislation. "CAF requirement" is acceptable shorthand internally; in
customer-facing material use "CAF contributing outcome" or "outcome the regulator
assesses against".

---

## 3. Energy regulatory scope

### 3.1 Competent authority

Ofgem is designated in the NIS Regulations as **joint Competent Authority with
BEIS** (functions now with **DESNZ**) for the **downstream gas and electricity
sectors in Great Britain** **[S]**.

- Ofgem has published NIS Enforcement Guidelines and a Penalty Policy **[S]**.
- Northern Ireland and, in part, devolved arrangements are **UNRESOLVED** in this
  package — not investigated to conclusion.

### 3.2 Sub-sectors and thresholds (Schedule 2)

Schedule 2 specifies, per sector/sub-sector, the essential service, the entity type
and a threshold requirement; an entity providing the essential service that does not
meet the threshold **is not an OES** **[S]**.

| Sub-sector | Threshold (as corroborated) | Tag |
|---|---|---|
| Electricity supply | Supply to more than 250,000 final customers | **[S]** |
| Electricity supply + generation | Cumulative generation capacity ≥ 2 GW (input to a transmission system), aggregated with affiliated undertakings | **[S]** |
| Electricity distribution | DSOs with potential to disrupt delivery to more than 250,000 final customers | **[S]** |
| Electricity transmission | TSOs whose disruption would affect more than 250,000 final customers | **[S]** |
| Offshore transmission | Licence holders ≥ 2 GW cumulative capacity | **[S]** |
| Interconnectors | Licence holders ≥ 1 GW | **[S]** |
| Electricity system operation | Not separately corroborated | **UNRESOLVED** |
| Gas transmission / distribution / other gas operators | Not separately corroborated; Ofgem CA scope is "downstream gas and electricity" | **UNRESOLVED** |

**Commercially critical consequence.** Thresholds mean **most energy companies are
not OES**. Generation below 2 GW sits outside the regime — a gap that attracted
public commentary in 2026 **[S, secondary/discovery only]**. Soterius must never
address energy prospects as though NIS applies to them by default. Whether a given
organisation is an OES is a **FACT to be established**, not inferred from sector.

### 3.3 Adjacent Ofgem cyber instruments

- **RIIO-2 Cyber Resilience Guidelines** for gas and electricity network licensees
  **[S]**. This is *price-control/licence* machinery, distinct from NIS, and is a
  second, independent regulatory driver for network companies.
- **NIS Security Assurance Guidance (Concept) for the DGE Sector** (OFG1164, 2025),
  addressed to OES and to approved cyber-security consultancies conducting Audit,
  Operational Exercising and Technical Testing **[S]**. This establishes that Ofgem
  contemplates a **named, approved assurance-supplier ecosystem** — relevant to §15.
- **NIS Guidance for Downstream Gas and Electricity Operators of Essential Services in
  GB, v3.0**, updated 14 January 2026 **[S]**. This is the current operative Ofgem
  guidance and is **the highest-priority document in the §17 verification worklist**.

---

## 4. Water regulatory scope

- **Essential service:** the NIS Regulations identify the **supply of potable water**
  as the essential service **[S]**.
- **Threshold:** supply of drinking water to **200,000 or more people** **[S]**.
- **Competent authority:** the DWI has been transferred the function of undertaking
  operational Competent Authority duties to regulate OES **on behalf of the Secretary
  of State (England) and the Welsh Government (Wales)** **[S]**. The DWI has published
  a NIS Enforcement Policy **[S]**.
- **Assessment mechanism:** annual CAF return from each in-scope company since 2018,
  mapping resilience to threat-actor capability across **39 contributing outcomes**
  **[S]**.
- **Supervisory intensity:** in 2023–24 **every** water company was subject to a DWI
  cyber-resilience audit verifying its self-assessed CAF position; **two companies
  were issued legal notices** to improve their risk assessments **[S]**.
- **Incident reporting:** to DWI without undue delay and no later than **72 hours** of
  awareness **[S]**.
- **Sewerage:** **UNRESOLVED.** Not corroborated as an in-scope essential service. Do
  not assume sewerage is within the NIS water sub-sector.
- **Ofwat:** economic regulator; not identified as a NIS competent authority.
  Cyber-relevant only through price-review/investment machinery. **UNRESOLVED** for
  this package. The DWI also participates in the price review process **[S]**.
- **SEMD (Security and Emergency Measures Direction):** a separate DWI-administered
  security regime **[S]**. Its cyber content is **UNRESOLVED** and is a verification
  item.

**Assessment.** Water is the more attractive utilities segment for Soterius on
regulatory grounds: fewer entities, a single operational CA, a *universal annual
CAF return*, demonstrated audit activity and demonstrated enforcement. The evidence
demand is annual, documented and verified.

---

## 5. Telecoms distinction — do not merge into NIS Utilities

The brief correctly anticipated that telecoms differs. It does, and the distinction is
statutory, not stylistic.

- **Reg. 8(1A)** of the NIS Regulations 2018 provides that a person providing a Public
  Electronic Communications Network (PECN) or Service (PECS) **cannot be designated an
  OES in respect of those services** **[S]**.
- **Reg. 8(1)** does not apply to a network or service provider subject to ss.105A–105C
  of the Communications Act 2003 **[S]**.
- Telecoms security duties instead arise under **Communications Act 2003 ss.105A–105D**
  (as amended by the Telecommunications (Security) Act 2021), supplemented by the
  **Electronic Communications (Security Measures) Regulations 2022** (in force
  1 October 2022) and the **Telecommunications Security Code of Practice**, enforced
  by **Ofcom** **[S]**.

**However — an important and easily-missed nuance.** Ofcom **is** a designated
competent authority under NIS for the **digital infrastructure sub-sector** **[S]**,
which under the UK regime covers **IXP operators, DNS service providers and TLD name
registries** **[S]**. Ofcom has published guidance for OES in the digital
infrastructure sector **[S]**.

**Consequences for Soterius:**

1. Telecoms operators must be analysed under a **different statutory regime** and must
   not be counted in a "NIS utilities" addressable market.
2. DNS providers and TLD registries **are** NIS-regulated entities. This regulates the
   *DNS provider*, and says nothing about whether a *utility* should deploy DNSSEC.
   Do not conflate the two — it is the most tempting available fallacy in this package.
3. The 2022 Regulations impose a **prescriptive** measure set, unlike NIS's outcome
   duty **[S]**. Whether any of those 16 measures names a control Soterius observes is
   **UNRESOLVED** and is a verification item with potentially high payoff: it is the
   only identified UK regime likely to name specific technical measures.

---

## 6. CAF analysis

### 6.1 Version currency

- Current version: **CAF v4.0**, released **4 August 2025** **[S]**.
- v4.0 introduced four major changes: a new section on attacker methods and
  motivations; a new section on secure software development and maintenance
  (**A4.b**); updates to security monitoring and threat hunting; and improved coverage
  of AI-related cyber risk **[S]**.
- Structure: four Objectives (A–D), 14 principles, each with contributing outcomes,
  each with **Indicators of Good Practice (IGPs)** in tables. NCSC states assessment
  of contributing outcomes is "primarily a matter of expert judgement" and that IGPs
  do not remove the need for informed cyber-security expertise and sector knowledge
  **[S]**.

**This last point is decisive for Soterius positioning.** NCSC itself says CAF
assessment is expert judgement, not indicator-counting. Any Soterius claim implying
automated CAF determination contradicts the framework's own text.

### 6.2 Correction to the brief's assumptions

The brief instructs assessment of "**C2 Proactive Security Event Discovery**". In
CAF v4.0 **principle C2 is titled "Threat Hunting"** **[S]**. The brief's terminology
reflects CAF v3.x. Per the brief's own rule ("If current legislation differs from the
assumptions in this package: follow current authoritative law and explicitly report
the difference"), this package uses **C2 Threat Hunting**. Any Soterius collateral
referring to "C2 Proactive Security Event Discovery" is citing a superseded version.

### 6.3 Principle-by-principle relevance

| Principle | Corroborated substance | Relevance to externally observable boundary security |
|---|---|---|
| **A1 Governance** | Not corroborated **[M]** | None material. Governance is organisational; external observation cannot evidence it. |
| **A2 Risk Management** | Objective A requires organisational structures, policies, processes and procedures to understand, assess and systematically manage security risks to N&IS supporting essential functions **[S]** | Weak. Soterius supplies an input to risk assessment, not the assessment. |
| **A3 Asset Management** | Everything required to deliver, maintain or support N&IS necessary for essential functions is **determined and understood**, including data, people, systems and supporting infrastructure; you cannot manage risk without understanding what assets are part of the essential function; the regime should consider dependencies, including supply-chain elements **[S]** | **Strongest anchor in the framework.** An unknown or forgotten internet-facing host/domain/certificate is an asset not "determined and understood". |
| **A4 Supply Chain** | Part of Objective A's systematic risk management; v4.0 adds **A4.b secure software development and support** **[S]** | **Second-strongest anchor.** External observation of supplier posture is admissible evidence in supplier risk management. A4.b is about *how software is built*, not supplier hygiene — do not claim it. |
| **B1 Service Protection Policies** | Not corroborated **[M]** | Weak — policy existence is not externally observable. |
| **B2 Identity & Access Control** | Not corroborated **[M]** | None material. Soterius observes no authentication. |
| **B3 Data Security** | Not corroborated **[M]** | Plausible anchor for TLS/data-in-transit, **but IGP wording unverified — do not rely on it.** Verification item. |
| **B4 System Security** | Secure-by-design approach; systems designed to make compromise difficult and **easy to detect**; protect from attacks exploiting software vulnerabilities; **B4.d: manage known vulnerabilities in N&IS to prevent adverse impact on essential functions**; where patching is impossible, other measures must fully mitigate **[S]** | **Primary technical anchor.** Expired certificates, obsolete TLS, exposed misconfigurations are known, externally visible vulnerability conditions. |
| **B5 Resilient Networks & Systems** | Principle exists in Objective B **[S]**; detail not corroborated | Weak. Soterius does not observe resilience. |
| **B6 Staff Awareness & Training** | Not corroborated **[M]** | None material. Not externally observable. |
| **C1 Security Monitoring** | Proactively detect adverse activity **within networks and information systems** affecting essential functions, including activity evading standard prevent/detect solutions; more than log collection — requires tools and skilled analysis to identify indicators of compromise timely; monitoring must evolve as systems change **[S]** | **INDIRECT only.** C1 is about internal telemetry. External posture monitoring is not C1 coverage. The "monitoring must evolve as systems change" clause is the *only* legitimate touchpoint, and it is thin. |
| **C2 Threat Hunting** | Looks beyond known IOCs used by automated detection under C1; requires experienced knowledge of network/system behaviour and intrusion characteristics **[S]** | **INDIRECT at best.** Soterius performs no hunting and observes no adversary activity. |
| **D1 Response & Recovery Planning** | Not corroborated **[M]** | None material. |

### 6.4 The required reasoning chain (worked example)

The brief requires that mappings not rest on terminological similarity. Applied to the
strongest case:

> **Signal:** Certificate security.
> **→ Externally observable condition:** `leaf_not_after`, `leaf_days_remaining`,
>   `cert_chain_complete`, `leaf_is_self_signed`, `tls_verification_result` observed
>   on a named host at a recorded timestamp.
> **→ Security property evidenced:** whether an internet-facing service presents a
>   currently valid, correctly chained certificate from a trusted issuer — i.e.
>   whether a known, dated, remediable exposure exists on a public asset.
> **→ CAF objective/principle:** B4 System Security, contributing outcome **B4.d
>   Vulnerability Management**; secondarily A3 Asset Management (the host must be a
>   known asset before its certificate can be managed).
> **→ Evidence:** B4.d requires management of known vulnerabilities in N&IS to prevent
>   adverse impact on essential functions **[S]**; A3 requires all supporting
>   infrastructure to be determined and understood **[S]**.
> **→ Limitations:** (a) the observed host may not support an essential function at
>   all — Soterius cannot tell; (b) a valid certificate proves nothing about the
>   operator's vulnerability-management *process*, which is what B4.d actually
>   assesses; (c) CAF assessment is expert judgement, not indicator-counting **[S]**;
>   (d) B4.d's exact IGP wording is unverified.
> **→ Class:** STRONGLY_SUPPORTIVE. **Not DIRECT** — no instrument names certificate
>   expiry monitoring.

By contrast, the following chain is **rejected** and must not be used:

> ~~Soterius monitors continuously → CAF C1 is called "Security Monitoring" →
> Soterius supports C1.~~ **REJECTED: terminological similarity only.** C1's subject
> matter is internal detection of adverse activity within the operator's systems
> **[S]**. Soterius observes external configuration state, not activity, not
> internally. This is precisely the inference the brief prohibits.

---

## 7. Full 14-area signal matrix

**Legend.** Class ∈ {DIRECT, STRONGLY_SUPPORTIVE, INDIRECT, NO_MATERIAL_RELATIONSHIP}.
Confidence reflects **the whole row including regulatory evidence quality**, and is
capped at MEDIUM everywhere because no primary text was read (see banner).
Sector scope is cross-sector (electricity, gas, water) unless stated.

**`DIRECT` is used zero times in this matrix.** That is the finding, not an omission.

---

### 7.1 DMARC

| Field | Content |
|---|---|
| **Observable evidence** | `_dmarc` TXT presence; `dmarc_policy` (none/quarantine/reject); `dmarc_subdomain_policy`; `dmarc_pct`; `dmarc_rua`/`dmarc_ruf` and counts; `dmarc_adkim`/`dmarc_aspf` alignment; `dmarc_record_count`, `dmarc_multiple_records`, `dmarc_syntax_errors` |
| **Regulation / framework** | NIS reg. 10 (via CAF); CAF B4; NCSC Email security and anti-spoofing guidance |
| **Exact reference** | NIS 2018 reg. 10 **[S]**; CAF B4 **[S]**; NCSC *Email security and anti-spoofing* collection **[S]** |
| **Regulatory wording** | *No verbatim extract available (see banner).* Paraphrase: reg. 10 requires appropriate and proportionate technical and organisational measures **[S]**. NCSC guidance recommends configuring anti-spoofing controls: implement DMARC, create and iterate SPF, create and manage DKIM, and recommends starting at `p=none` as a monitoring phase, with `p=reject` on all domains as the best way to prevent spoofing **[S]**. |
| **Relationship class** | **INDIRECT** |
| **Reasoning** | No UK utilities regulator instrument identified names DMARC. NCSC recommends it, but **NCSC general guidance is not a utilities regulatory requirement** unless a CA adopts it — no evidence found that Ofgem or DWI has. DMARC principally protects *third parties* from impersonation of the operator's domain; it does not protect the network and information systems on which the essential service relies, which is reg. 10's subject. It is genuine hygiene evidence, not fulfilment evidence. |
| **Limitations** | Cannot infer inbound phishing protection; cannot infer whether the domain sends mail at all; `p=reject` at `pct<100` is partial; a parked/non-sending domain with no DMARC carries different risk than an operational one; presence of `rua` does not mean reports are read or acted on. |
| **Sector scope** | Cross-sector |
| **Confidence** | **MEDIUM** (that it is *not* mandated: MEDIUM-HIGH; that INDIRECT is the right class: MEDIUM) |

### 7.2 SPF

| Field | Content |
|---|---|
| **Observable evidence** | `spf_present`, `spf_record`, `spf_mechanism` (all/~all/-all), `spf_lookup_count`, `spf_include_count`, `spf_record_count`, `spf_multiple_records`, `spf_syntax_errors` |
| **Regulation / framework** | NIS reg. 10 (via CAF); CAF B4; NCSC anti-spoofing guidance |
| **Exact reference** | As 7.1 **[S]** |
| **Regulatory wording** | Paraphrase: NCSC describes SPF as publishing IP addresses that should be trusted for your domain **[S]**. No utilities-regulator wording identified. |
| **Relationship class** | **INDIRECT** |
| **Reasoning** | Identical to DMARC. Additionally SPF alone is weaker: it authenticates the envelope sender path, is defeated by forwarding, and without DMARC has no enforcement semantics. `spf_lookup_count` >10 is an operational defect but not a regulated one. |
| **Limitations** | A permissive `?all`/`+all` is observable but its risk depends on sending architecture Soterius cannot see; SPF presence says nothing about whether all legitimate senders are enumerated. |
| **Sector scope** | Cross-sector |
| **Confidence** | **MEDIUM** |

### 7.3 DKIM

| Field | Content |
|---|---|
| **Observable evidence** | `dkim_present` (**two-state: true or null — never false**), `dkim_selectors_probed`/`dkim_selectors_found`, `dkim_collection_status` (incl. `NOT_DETECTED`), key material: `key_type`, `key_bits`, `hash_algorithms`, `public_key_present`, `flags` |
| **Regulation / framework** | NIS reg. 10 (via CAF); CAF B4; NCSC anti-spoofing guidance |
| **Exact reference** | As 7.1 **[S]** |
| **Regulatory wording** | Paraphrase: NCSC describes DKIM as allowing cryptographic signing of email to show it is from your domain **[S]**. |
| **Relationship class** | **INDIRECT** |
| **Reasoning** | As DMARC/SPF, with a material additional weakness that is an **architectural fact of the Soterius collector, not an opinion**: the DKIM selector namespace is non-enumerable, so absence is unprovable. The collector encodes this — `NOT_DETECTED` means "all probes in a bounded probe set completed without finding a key", which the observation layer maps to `OBSERVED_ABSENT` while preserving the bounded nuance in `dkim_collection_status`. |
| **Limitations** | **Soterius can never assert "this organisation does not use DKIM."** Only "no key was found across probe set version *v*." Any customer-facing DKIM negative must carry the probe-set bound. Key length observable; signing practice is not. |
| **Sector scope** | Cross-sector |
| **Confidence** | **MEDIUM** (LOW for any negative finding) |

### 7.4 MTA-STS

| Field | Content |
|---|---|
| **Observable evidence** | `dns_sts_present`, `dns_id`, `dns_version`; policy layer: `policy_present`, `policy_mode` (none/testing/enforce), `policy_max_age`, `policy_mx_patterns`/`policy_mx_count`, `policy_tls_valid`, `policy_body_tls_validated`, `policy_http_status`, `policy_redirect_count`, syntax/unknown-field diagnostics |
| **Regulation / framework** | NIS reg. 10 (via CAF); CAF B3 (data in transit, **unverified**); CAF B4 |
| **Exact reference** | NIS 2018 reg. 10 **[S]**; CAF B3/B4 **[M for B3 detail]** |
| **Regulatory wording** | *No wording identified naming MTA-STS in any UK instrument or utilities-regulator guidance.* |
| **Relationship class** | **INDIRECT** |
| **Reasoning** | MTA-STS enforces authenticated, encrypted SMTP transport, protecting mail in transit from downgrade and interception — a data-in-transit protection outcome plausibly within CAF B3. But B3's IGP wording was not verifiable, MTA-STS is named nowhere, and adoption is low enough that absence is unremarkable. Failing closed per the brief: INDIRECT. |
| **Limitations** | `policy_mode=testing` provides no enforcement; policy presence does not prove MX hosts actually honour it; observes the operator's *inbound* transport policy only, not outbound behaviour. |
| **Sector scope** | Cross-sector |
| **Confidence** | **MEDIUM** |

### 7.5 TLS-RPT

| Field | Content |
|---|---|
| **Observable evidence** | `dns_tlsrpt_present`, `rua_uris`, `rua_mailto_count`, `rua_https_count`, `rua_unknown_scheme_count`, record count/duplication, syntax and unknown-tag diagnostics |
| **Regulation / framework** | NIS reg. 10 (via CAF); CAF C1 (tenuous) |
| **Exact reference** | NIS 2018 reg. 10 **[S]** |
| **Regulatory wording** | *None identified.* |
| **Relationship class** | **INDIRECT** — *the weakest row in the matrix* |
| **Reasoning** | TLS-RPT establishes a reporting channel for SMTP TLS failures. It is a visibility affordance, not a control. The temptation is to map it to C1 "Security Monitoring"; that is exactly the terminological fallacy §6.4 rejects — C1 concerns detection of adverse activity within the operator's systems **[S]**, not receipt of third-party transport telemetry. |
| **Limitations** | Presence proves a reporting address is published, nothing more: not that reports are received, parsed, read or acted upon. Among the 14 areas this carries the least regulatory weight and should be de-emphasised in utilities positioning. |
| **Sector scope** | Cross-sector |
| **Confidence** | **MEDIUM** (that it is weak: HIGH-ish; regulatory evidence: LOW) |

### 7.6 DNSSEC

| Field | Content |
|---|---|
| **Observable evidence** | `dns_ds_present`, `dns_dnskey_present` (both three-state), `ds_algorithms`, `ds_digest_types`, `ds_key_tags`, `dnskey_algorithms`, `dnskey_ksk_count`/`dnskey_zsk_count`; envelope emits PRESENT/ABSENT only when **both** axes resolved |
| **Regulation / framework** | NIS reg. 10 (via CAF); CAF A3, B4 |
| **Exact reference** | NIS 2018 reg. 10 **[S]**; CAF A3 **[S]**, B4 **[S]** |
| **Regulatory wording** | Paraphrase: A3 requires supporting infrastructure to be determined and understood **[S]**. *No UK utilities instrument identified names DNSSEC.* |
| **Relationship class** | **INDIRECT** |
| **Reasoning** | DNS resolution integrity underpins every other externally observable control; a hijacked zone defeats TLS trust decisions and mail routing. That is a real security property. But: (a) nothing names DNSSEC; (b) UK adoption is low enough that absence carries no adverse regulatory inference; (c) the operator often does not control signing (registrar/DNS provider does). **Do not conflate** with the separate fact that DNS service providers and TLD registries are themselves NIS digital-infrastructure OES under Ofcom **[S]** — that regulates the provider, not the utility's zone. |
| **Limitations** | Record presence is **not** validity: the collector explicitly documents that PRESENT means DNSSEC material was observed, **not** that DNSSEC is valid or correctly anchored — chain-of-trust judgement is a separate Quality Model concern (ANCHORED/ISLAND/UNSIGNED). Any external claim must respect that boundary. |
| **Sector scope** | Cross-sector |
| **Confidence** | **MEDIUM** |

### 7.7 TLS

| Field | Content |
|---|---|
| **Observable evidence** | `negotiated_version`, `cipher_suite_standard`, `cipher_symmetric_alg`, `cipher_key_exchange`, `forward_secrecy`, `key_share_group`, `ocsp_stapling_present`, `alpn_protocol`/`http2_negotiated`, `session_ticket_issued`, `endpoint_state`, `connection_error_code` |
| **Regulation / framework** | NIS reg. 10 (via CAF); CAF **B4** (incl. B4.d); CAF B3 (**unverified**) |
| **Exact reference** | NIS 2018 reg. 10 **[S]**; CAF B4 / B4.d **[S]** |
| **Regulatory wording** | Paraphrase: organisations should protect N&IS from attacks that seek to exploit software vulnerabilities; B4.d requires managing known vulnerabilities in N&IS to prevent adverse impact on essential functions; where patching is not possible, other measures must fully mitigate the risk **[S]**. |
| **Relationship class** | **STRONGLY_SUPPORTIVE** |
| **Reasoning** | Obsolete protocol versions and weak cipher suites on internet-facing services are **known vulnerabilities** in the ordinary sense B4.d addresses, and they are externally verifiable without access or consent. Unlike the email signals, this is a property of a system the operator runs, reachable by an attacker, and squarely within "protect N&IS from attacks exploiting vulnerabilities" **[S]**. Not DIRECT: no instrument specifies a TLS version floor for utilities. |
| **Limitations** | Soterius observes the endpoints it knows about, not the estate; cannot determine whether an endpoint supports an essential function; a modern TLS posture evidences configuration state at one instant, not a vulnerability-management *process* — which is what B4.d assesses; OT and internal systems are entirely out of view. |
| **Sector scope** | Cross-sector |
| **Confidence** | **MEDIUM** |

### 7.8 Certificate security

| Field | Content |
|---|---|
| **Observable evidence** | `certificate_present`, `leaf_not_before`/`leaf_not_after`, `leaf_days_remaining`, `leaf_lifetime_days`, `cert_chain_complete`, `cert_chain_depth`, `leaf_is_self_signed`, `leaf_is_wildcard`, `leaf_key_type`/`leaf_key_bits`/`leaf_key_curve`, `leaf_signature_algorithm`, `leaf_issuer_o`/`leaf_issuer_cn`, `leaf_san_entries`/`leaf_san_count`, `leaf_aia_ocsp_urls`, `leaf_policy_oids`, `leaf_fingerprint_sha256`, `tls_verification_result` |
| **Regulation / framework** | NIS reg. 10 (via CAF); CAF **B4.d**, **A3** |
| **Exact reference** | NIS 2018 reg. 10 **[S]**; CAF B4.d **[S]**; CAF A3 **[S]** |
| **Regulatory wording** | Paraphrase: B4.d — manage known vulnerabilities in N&IS to prevent adverse impact on essential functions **[S]**. A3 — everything required to deliver, maintain or support N&IS necessary for essential functions is determined and understood, including supporting infrastructure **[S]**. |
| **Relationship class** | **STRONGLY_SUPPORTIVE** |
| **Reasoning** | Certificate expiry is the cleanest available case: a **dated, deterministic, remediable exposure** with a known future failure time, externally verifiable, and a recurring real-world cause of service outage — which engages reg. 10's *continuity of service* limb as well as its security limb **[S]**. `leaf_san_entries` additionally surfaces hostnames the operator may not have inventoried, feeding A3 directly. |
| **Limitations** | Chain validity at observation time is not a claim about private-key custody, issuance process, or renewal automation; wildcard usage is a design choice, not a defect; observation covers reachable endpoints only. |
| **Sector scope** | Cross-sector |
| **Confidence** | **MEDIUM** |

### 7.9 Security headers

| Field | Content |
|---|---|
| **Observable evidence** | `header_pairs`/`headers` with `name_raw`, `value_raw`, `position`, `count`, duplication; `http_probe_state`, `endpoint_state`, `fetch_outcome`, `http_status`, `redirect_chain`, `tls_verification_result` |
| **Regulation / framework** | NIS reg. 10 (via CAF); CAF B4 |
| **Exact reference** | NIS 2018 reg. 10 **[S]**; CAF B4 **[S]** |
| **Regulatory wording** | Paraphrase: B4 requires a secure-by-design approach so systems are designed to make compromise difficult and to avoid disruption **[S]**. *No instrument identified names any specific HTTP response header.* |
| **Relationship class** | **INDIRECT** |
| **Reasoning** | HSTS, CSP, frame/`nosniff` controls are web-application hardening. They protect *website users* against browser-delivered attacks; they do not protect the network and information systems supporting the essential function, which is reg. 10's subject. A utility's corporate website is rarely an essential-function system. Genuine hygiene evidence; weak regulatory evidence. |
| **Limitations** | Header presence is not correctness — a permissive CSP with `unsafe-inline` passes presence checks while providing little protection, and Soterius records value text rather than adjudicating policy strength; scoped to observed endpoints only. |
| **Sector scope** | Cross-sector |
| **Confidence** | **MEDIUM** |

### 7.10 security.txt

| Field | Content |
|---|---|
| **Observable evidence** | `file_state`/`content_state`, `contact`, `expires`, `policy`, `encryption`, `acknowledgments`, `canonical` (+ `canonical_fetch`/`canonical_parse`), `preferred_languages`, `hiring`, `pgp_signature_raw`/`pgp_signed_body_raw`, `known_field_count`/`unknown_fields`, `malformed_line_count`, `legacy_fetch` (legacy path vs `/.well-known`) |
| **Regulation / framework** | NIS reg. 10 (via CAF); CAF **B4.d**; NCSC Vulnerability Disclosure Toolkit; RFC 9116 |
| **Exact reference** | NIS 2018 reg. 10 **[S]**; CAF B4.d **[S]**; NCSC *Vulnerability Disclosure Toolkit* v2 **[S]**; RFC 9116 **[S]** |
| **Regulatory wording** | Paraphrase: the NCSC toolkit contains **three components — Communication, Policy, and Security.txt** — and describes security.txt as an IETF informational specification (RFC 9116) for a file hosted in `/.well-known` at the domain root that advertises the organisation's vulnerability disclosure process, with `CONTACT` specifying how finders should report vulnerabilities **[S]**. |
| **Relationship class** | **STRONGLY_SUPPORTIVE** |
| **Reasoning** | **This is the only signal in the package that a UK national authority names as a component of a security process.** The chain is unusually short: security.txt → NCSC-named component of vulnerability disclosure → the intake path by which an organisation *learns of* vulnerabilities → B4.d's requirement to manage known vulnerabilities **[S]**. An organisation with no disclosure route has a structural gap in how vulnerabilities become "known" to it. |
| **Limitations** | **The naming authority is NCSC guidance, not a utilities-regulator instrument.** No evidence was found that Ofgem or DWI has adopted the toolkit, so this is *not* DIRECT and is not a regulatory requirement in the utilities sectors. File presence proves publication, not that reports are triaged, or that any disclosure process exists behind the address. An expired `Expires` field indicates staleness but not process failure. |
| **Sector scope** | Cross-sector |
| **Confidence** | **MEDIUM** (that NCSC names it: MEDIUM-HIGH; that it is not regulator-adopted: MEDIUM — verification item) |

### 7.11 CAA

| Field | Content |
|---|---|
| **Observable evidence** | `dns_caa_present`, `caa_issue_values`/`caa_issue_count`, `caa_issuewild_values`/`caa_issuewild_count`, `caa_iodef_values`/`caa_iodef_count`, `caa_critical_count`, `caa_tags_present`, `caa_unknown_tag_count`, `caa_record_count` |
| **Regulation / framework** | NIS reg. 10 (via CAF); CAF A3, B4 |
| **Exact reference** | NIS 2018 reg. 10 **[S]**; CAF A3 **[S]**, B4 **[S]** |
| **Regulatory wording** | *No UK instrument identified names CAA.* |
| **Relationship class** | **INDIRECT** |
| **Reasoning** | CAA constrains which CAs may issue for a domain — a genuine, if narrow, control against mis-issuance, and `iodef` provides a mis-issuance reporting channel. But it is unnamed anywhere, adoption is low, and absence is the norm rather than a deficiency. Fail closed. |
| **Limitations** | CAA is advisory to CAs at issuance time and does not prevent an already-issued certificate from being used; a permissive `issue` set provides little constraint; presence tells nothing about certificate lifecycle governance. |
| **Sector scope** | Cross-sector |
| **Confidence** | **MEDIUM** |

### 7.12 External / domain attack-surface visibility

| Field | Content |
|---|---|
| **Observable evidence** | The union of the above across an organisation's known domain estate: which hostnames resolve, which present TLS endpoints, `leaf_san_entries` revealing additional names, `endpoint_state`, `redirect_chain`, registrar/DNS-provision and cloud-host attribution, and per-domain observation coverage |
| **Regulation / framework** | NIS reg. 10 (via CAF); CAF **A3**, **B4**; NCSC EASM positioning |
| **Exact reference** | NIS 2018 reg. 10 **[S]**; CAF A3 **[S]**; CAF B4/B4.d **[S]**; NCSC *Retiring Mail Check and Web Check* **[S]** |
| **Regulatory wording** | Paraphrase: A3 — everything required to deliver, maintain or support N&IS necessary for essential functions is determined and understood, including supporting infrastructure; **you cannot effectively manage risks without understanding what assets are part of the essential function**; the regime should consider all relevant assets and dependencies **[S]**. NCSC (on retiring its own services): EASM products "identify and scan your internet-accessible assets to identify any misconfigurations, exposures or vulnerabilities that could be exploited by an attacker", which is **effectively the same function** Web Check and Mail Check provided since 2017 **[S]**. |
| **Relationship class** | **STRONGLY_SUPPORTIVE** |
| **Reasoning** | The strongest row in the matrix. A3's requirement that supporting infrastructure be "determined and understood" is failed precisely by the forgotten subdomain, the unmanaged certificate and the shadow internet-facing host — the things external observation finds and internal inventory misses. Independently, the NCSC has characterised this exact product category as performing the function of its own CNI-facing services and has directed organisations to adopt it **[S]**. |
| **Limitations** | **Soterius observes a *known* domain estate, not a discovered one** — completeness of the domain list bounds every claim, and unknown-unknowns are exactly what A3 is about. No IP-range, cloud-tenant, OT or ICS discovery. No claim of estate completeness may be made. NCSC's statement is about a market category, **not** about Soterius. |
| **Sector scope** | Cross-sector |
| **Confidence** | **MEDIUM** (highest in the matrix) |

### 7.13 Continuous monitoring of externally observable security posture

| Field | Content |
|---|---|
| **Observable evidence** | Deterministic recurring re-observation of every signal per organisation (daily cadence for SPF/DKIM/DMARC; weekly for DNSSEC/CAA, on fixed UTC shards), producing a time series with explicit four-state collection outcomes (`OBSERVED_PRESENT`/`OBSERVED_ABSENT`/`NOT_OBSERVED`/`COLLECTION_ERROR`) and full collector-version provenance per observation |
| **Regulation / framework** | CAF **C1**, **C2** — *and separately* CAF **A3**, **B4.d** |
| **Exact reference** | CAF C1 **[S]**; CAF C2 Threat Hunting **[S]**; CAF A3 **[S]**; CAF B4.d **[S]** |
| **Regulatory wording** | Paraphrase, C1: proactively detect, **within networks and information systems**, adverse activity affecting or potentially affecting the operation of essential functions, including activity evading standard prevent/detect solutions; good monitoring is more than collecting logs and requires appropriate tools and skilled analysis to identify indicators of compromise in a timely manner; the monitoring capability must be updated as systems and networks develop **[S]**. C2: hunting looks beyond the known IOCs leveraged by the automated detection covered in C1 and requires experienced knowledge of network and system behaviour **[S]**. |
| **Relationship class** | **Split — this row must not be collapsed:**<br>• vs **C1 / C2: INDIRECT**<br>• vs **A3 / B4.d: STRONGLY_SUPPORTIVE** |
| **Reasoning** | Against C1/C2: Soterius observes **configuration state from outside**, not **adversary activity from inside**. It generates no IOCs, ingests no logs, performs no analysis of behaviour, and covers none of the operator's internal N&IS. Claiming C1/C2 support would be the terminological fallacy the brief prohibits. The one narrow legitimate touchpoint is C1's requirement that monitoring evolve as systems change **[S]** — a changing external estate is a change a monitoring strategy should account for — and that alone does not lift the class. Against A3/B4.d: continuity is what makes the evidence valuable. A single scan is a snapshot; recurring observation with provenance evidences that exposures are being *watched over time*, which is what asset and vulnerability management actually require. |
| **Limitations** | **Soterius alone satisfies neither C1 nor C2 and must never be described as doing so.** Cadence is daily/weekly, not real-time — an exposure introduced and removed between observations is invisible. `NOT_OBSERVED` and `COLLECTION_ERROR` are not `ABSENT`, and any external reporting must preserve that distinction or it will overstate findings. |
| **Sector scope** | Cross-sector |
| **Confidence** | **MEDIUM** (the C1/C2 exclusion is the higher-confidence half of this row) |

### 7.14 Supplier / third-party external security monitoring

| Field | Content |
|---|---|
| **Observable evidence** | The full signal set observed against supplier domains, without supplier consent, access or instrumentation; comparable across suppliers and repeatable over time |
| **Regulation / framework** | CAF **A4** (Supply Chain), CAF **A3**; Ofgem *Supply Chain Security: Proposed Guidance* (**consultation**); CSR Bill critical-supplier regime (**proposed, not in force**) |
| **Exact reference** | CAF A4 **[S]**; CAF A3 (dependencies incl. supply chain) **[S]**; Ofgem Supply Chain Security consultation, June 2026 **[S]**; CSR Bill *Designating critical suppliers* factsheet **[S]** |
| **Regulatory wording** | Paraphrase: A3 states dependencies may be identified between assets under your control, **elements of the supply chain**, and key staff **[S]**. Objective A requires organisational structures, policies, processes and procedures to understand, assess and systematically manage security risks to N&IS supporting essential functions **[S]**. Ofgem's proposed guidance provides a structured framework for assessing supplier criticality based on how supplier failure, compromise or dependency could affect essential functions, across dimensions of supplier stability, access and influence, and impact and propagation — and states the framework is **not intended to produce a single composite score or automated classification**, instead supporting consistent, repeatable assessment so that governance, assurance and control expectations can be applied proportionately, and designed to support dialogue and transparency **rather than replace organisational risk assessment or act as a checklist or minimum compliance baseline** **[S]**. |
| **Relationship class** | **STRONGLY_SUPPORTIVE** |
| **Reasoning** | Supplier assurance is the one area where an operator has an explicit obligation to form a view about **someone else's** security, and where it has the least internal telemetry to do so. External observation is the natural evidence class. Ofgem is actively building the machinery **[S]**, and the CSR Bill proposes to make critical suppliers directly regulated **[S]**. |
| **Limitations** | **Ofgem's own wording is a direct constraint on Soterius product design**: a composite supplier score presented as a criticality or assurance classification runs *against* the stated intent of the framework **[S]**. External posture evidences a supplier's internet-facing hygiene only — not its access to the operator's systems, its internal controls, its OT exposure, or its "access and influence" dimension, which are the dimensions Ofgem actually weights. The guidance was **at consultation** (closed 26 June 2026; outcome due August 2026) — whether finalised by 2026-09-03 is **UNRESOLVED**. |
| **Sector scope** | Energy (Ofgem evidence); cross-sector for CAF A4 |
| **Confidence** | **MEDIUM** |

### 7.15 Matrix summary

| # | Area | Class | Primary anchor |
|---|---|---|---|
| 1 | DMARC | INDIRECT | CAF B4 (via NCSC guidance, not regulator-adopted) |
| 2 | SPF | INDIRECT | CAF B4 |
| 3 | DKIM | INDIRECT | CAF B4 |
| 4 | MTA-STS | INDIRECT | CAF B3/B4 (B3 unverified) |
| 5 | TLS-RPT | INDIRECT (weakest) | — |
| 6 | DNSSEC | INDIRECT | CAF A3/B4 |
| 7 | TLS | **STRONGLY_SUPPORTIVE** | CAF B4 / B4.d |
| 8 | Certificate security | **STRONGLY_SUPPORTIVE** | CAF B4.d / A3 |
| 9 | Security headers | INDIRECT | CAF B4 |
| 10 | security.txt | **STRONGLY_SUPPORTIVE** | CAF B4.d + NCSC Vulnerability Disclosure Toolkit |
| 11 | CAA | INDIRECT | CAF A3/B4 |
| 12 | External attack-surface visibility | **STRONGLY_SUPPORTIVE** | CAF A3 (+ NCSC EASM positioning) |
| 13 | Continuous monitoring | **INDIRECT vs C1/C2**; STRONGLY_SUPPORTIVE vs A3/B4.d | CAF A3, B4.d |
| 14 | Supplier external monitoring | **STRONGLY_SUPPORTIVE** | CAF A4 + Ofgem supply-chain consultation |

**DIRECT: 0. STRONGLY_SUPPORTIVE: 5 (+1 split). INDIRECT: 8 (+1 split).
NO_MATERIAL_RELATIONSHIP: 0.**

*Note on the absence of NO_MATERIAL_RELATIONSHIP:* every signal has some defensible
relationship to the boundary-security outcomes CAF assesses. The honest distinction in
this package is therefore between INDIRECT and STRONGLY_SUPPORTIVE, and the INDIRECT
majority is the substantive finding — not a formality.

---

## 8. Email-security analysis (Stage 5)

**Question:** does any utilities regulator, or NCSC guidance incorporated into the
regulatory regime, or other authoritative UK CNI guidance, explicitly address email
authentication, spoofing, phishing protection, DMARC, SPF, DKIM, secure mail
transport, MTA-STS or TLS-RPT?

**Findings:**

| Control | Mandated | Expected by a utilities regulator | Recommended (non-regulatory) | Referenced as example | Absent |
|---|---|---|---|---|---|
| DMARC | No | **Not evidenced** | **Yes — NCSC** **[S]** | — | — |
| SPF | No | Not evidenced | **Yes — NCSC** **[S]** | — | — |
| DKIM | No | Not evidenced | **Yes — NCSC** **[S]** | — | — |
| MTA-STS | No | Not evidenced | Not evidenced in this session | — | Effectively absent from identified UK regulatory material |
| TLS-RPT | No | Not evidenced | Not evidenced in this session | — | Effectively absent |
| Email authentication generally | No | Not evidenced | Yes **[S]** | — | — |

**Detail.**

1. **NCSC recommends, in detail, but recommendation is not regulation.** The NCSC
   *Email security and anti-spoofing* collection sets out a staged implementation:
   choose an anti-spoofing management tool; configure anti-spoofing controls (DMARC,
   SPF, DKIM); mark spoof email as spam; reject spoof email — beginning at DMARC
   `p=none` as a monitoring phase and treating `p=reject` on all domains as the best
   way to prevent spoofing **[S]**.

2. **The nearest thing to a UK mandate is public-sector, not utilities.** NCSC's Mail
   Check served UK public sector organisations (and schools/FE/HE) **[S]**. Utilities
   OES are not public-sector bodies. **Any inference from public-sector email policy to
   utilities obligations is invalid and must be blocked in Soterius messaging.**

3. **Mail Check was retired on 31 March 2026** **[S]**, so even that public-sector
   tooling anchor no longer exists in its previous form.

4. **No evidence was found that Ofgem or DWI has adopted NCSC email guidance** into its
   NIS guidance. This is a **verification item**, not a settled negative — Ofgem's
   *NIS Guidance for DGE OES v3.0* (14 January 2026) and the *CAF Overlay for the DGE
   Sector* were not retrievable, and either could reference email controls. Status:
   **UNRESOLVED, currently assessed as absent.**

5. **Whether CAF v4.0 IGPs mention email authentication anywhere** is **UNRESOLVED**.
   Even if they do, an IGP is an indicator informing expert judgement, not a
   requirement — NCSC states IGPs do not remove the need for informed expertise and
   should be used flexibly **[S]**.

**Conclusion for Stage 5.** Email authentication in UK utilities is **recommended
best practice, not a regulatory requirement**. Soterius's email signals are its
*weakest* regulatory ground despite being, commercially, its most recognisable. This
inversion is the single most important corrective in the package.

---

## 9. DNS / domain / boundary-security analysis (Stage 6)

**Question:** does CAF or sector guidance create a stronger regulatory basis for the
domain-security observations than for the individual email controls?

**Answer: yes, materially stronger.** Three independent reasons:

1. **A3 asset management is squarely on point and is corroborated.** A3 requires that
   everything required to deliver, maintain or support N&IS necessary for essential
   functions — including supporting infrastructure — be determined and understood, and
   states you cannot effectively manage risks without understanding what assets are
   part of the essential function **[S]**. Domains, hostnames, certificates and
   internet-facing endpoints are precisely such supporting infrastructure. Email
   authentication records, by contrast, are a control *about outbound messaging*, not
   an asset-management fact.

2. **B4/B4.d is corroborated and applies to exposures, not to protocols.** B4 requires
   protection from attacks exploiting vulnerabilities and a secure-by-design approach
   where systems are designed to make compromise difficult **and easy to detect**;
   B4.d requires managing known vulnerabilities in N&IS to prevent adverse impact on
   essential functions **[S]**. Expired certificates, broken chains and obsolete TLS
   are exposures of that kind. DMARC absence is not.

3. **NCSC has explicitly located this function in the EASM product category and
   directed organisations to it** **[S]** — see §11.

**Per-topic assessment:**

| Topic | Basis | Class |
|---|---|---|
| Internet-facing services / externally exposed services | CAF B4; NCSC guidance on protecting internet-facing services, incl. logging capability and privileged-operation constraints **[S]** | STRONGLY_SUPPORTIVE (as a category) |
| Attack-surface management | CAF A3 + NCSC EASM positioning **[S]** | STRONGLY_SUPPORTIVE |
| Vulnerability management | CAF B4.d **[S]** | STRONGLY_SUPPORTIVE (for externally visible exposures only) |
| Boundary protection | CAF B4 **[S]** | INDIRECT — Soterius observes the boundary's public face, not its controls |
| Certificate management | CAF B4.d / A3 **[S]** | STRONGLY_SUPPORTIVE |
| HTTPS / TLS | CAF B4 / B4.d **[S]** | STRONGLY_SUPPORTIVE |
| DNS integrity / DNSSEC | CAF A3 / B4 **[S]**; nothing names DNSSEC | INDIRECT |
| CAA | Nothing identified | INDIRECT |
| Domain / subdomain management | CAF A3 **[S]** | STRONGLY_SUPPORTIVE for *known* domains; **cannot claim discovery of unknown ones** |

**Caution.** NCSC's guidance on protecting internet-facing services concerns *design
and logging* of those services **[S]** — privileged access, event capture — not
external configuration observation. It supports the *importance* of the domain, not
Soterius's method. Do not cite it as a mapping.

---

## 10. Continuous-monitoring analysis (Stage 7)

**Does NIS/CAF/Ofgem/DWI require or strongly expect continuous monitoring?** Yes for
monitoring in the C1 sense — but that is **not** what Soterius does.

| Expectation | Evidenced? | Does Soterius support it? |
|---|---|---|
| Continuous security monitoring | Yes — CAF C1 **[S]** | **No** — C1 is internal detection of adverse activity **[S]** |
| Ongoing detection | Yes — CAF C1 **[S]** | No |
| Monitoring of internet-facing services | Partially — CAF B4 + NCSC internet-facing guidance (logging/design focus) **[S]** | **Partially** — external configuration state only |
| Monitoring of DNS/domain assets | Via A3 asset management **[S]** | **Yes** — for known domains |
| Monitoring of web traffic | Yes (C1) **[S]** | **No** — Soterius sees no traffic |
| Email monitoring | Not evidenced as a regulatory expectation | No — Soterius sees no mail flow |
| Proactive discovery of security events | Yes — C2 Threat Hunting **[S]** | **No** — no events, no hunting |
| Identifying changes in externally exposed infrastructure | Via A3 **[S]** | **Yes** — this is the actual capability |

**C1 assessment.** C1 requires proactive detection *within* networks and information
systems of adverse activity affecting essential functions, including activity evading
standard prevent/detect solutions, using appropriate tools and skilled analysis to
identify indicators of compromise in a timely manner **[S]**. Soterius performs none
of these. Its one honest touchpoint is C1's requirement that the monitoring capability
be **updated as systems, networks and software versions develop** **[S]** — an
external-estate change feed is a legitimate *input* to keeping monitoring coverage
current. That is a supporting input to a C1 process, not C1 coverage.
**Class: INDIRECT.**

**C2 assessment.** C2 (Threat Hunting in v4.0 **[S]**) looks beyond known IOCs and
requires experienced knowledge of network and system behaviour and of intrusion
characteristics **[S]**. Soterius produces no hypotheses about adversary activity and
observes no behaviour. **Class: INDIRECT, bordering on NO_MATERIAL_RELATIONSHIP.**
If forced to choose one CAF principle Soterius should *stop* citing, it is C2.

**Where continuity genuinely earns its keep:** A3 and B4.d. An asset register that is
"determined and understood" **[S]** is a live property, not a document; a
vulnerability-management regime that prevents adverse impact **[S]** depends on
exposures being noticed while they still matter. Soterius's deterministic recurring
observation, with per-observation provenance and explicit four-state outcomes,
evidences that external exposures are under continuing observation.
**Class: STRONGLY_SUPPORTIVE.**

**Mandatory constraint.** *Soterius alone satisfies neither C1 nor C2.* This sentence,
or its equivalent, must appear in any Soterius material that mentions CAF Objective C.

---

## 11. Supply-chain requirements (Stage 8)

### 11.1 What regulated operators are expected to do

- **CAF A3** expects dependencies to be identified between assets under the
  organisation's control, **elements of the supply chain**, and key staff **[S]**.
- **CAF A4** sits within Objective A's requirement for structures, policies, processes
  and procedures to understand, assess and systematically manage security risks to
  N&IS supporting essential functions **[S]**. CAF v4.0 adds **A4.b secure software
  development and support**, addressing how software is built and maintained, not only
  procured — secure coding, code review, vulnerability scanning, security-prioritising
  pipelines **[S]**.
- **DWI**: 39 contributing outcomes returned annually **[S]**; specific supply-chain
  content **UNRESOLVED**.
- **Ofgem**: NIS guidance that OES "must have regard to" **[S]**; NIS Security
  Assurance Guidance contemplating approved suppliers, and stating that accredited
  organisations shall only subcontract to other approved suppliers, and that existing
  arrangements with key service providers will be accepted where they meet the desired
  outcomes such as equivalent accreditation standards **[S]**.

### 11.2 Ofgem's supply-chain guidance (the most important development)

Ofgem consulted on **Supply Chain Security: Proposed Guidance** (published June 2026;
Stage 2 consultation closed 26 June 2026; responses and consultation outcome due
August 2026) **[S]**. The appendix provides a structured framework for assessing
**supplier criticality** based on how supplier failure, compromise or dependency could
affect essential functions, across dimensions of **supplier stability, access and
influence, impact and propagation** **[S]**.

Three statements in that document constrain Soterius directly **[S]**:

1. It is **not intended to produce a single composite score or automated
   classification**.
2. It supports **consistent and repeatable assessment**, so that governance, assurance
   and control expectations can be applied **proportionately**.
3. It is designed to **support dialogue and transparency rather than replace
   organisational risk assessment**, and is not a checklist or minimum compliance
   baseline.

**Product implication.** A supplier "score" or automatic tiering presented as
criticality or assurance classification is **contrary to the regulator's stated
intent**. But (2) is an *invitation*: "consistent and repeatable" is exactly what
deterministic, versioned, provenance-carrying observation provides. Soterius should
position as **repeatable evidence input to a human assessment**, never as the
assessment. This is a positioning constraint that also happens to be a positioning
opportunity.

### 11.3 The regulatory chain

```
Regulated operator (OES: Ofgem-regulated DGE, or DWI-regulated water undertaker)
  │  NIS reg. 10 — appropriate and proportionate measures for the N&IS on which
  │  the essential service relies                                            [S]
  ▼
Supplier dependency (contractor, MSP, software or service provider)
  │  CAF A3 — dependencies incl. supply-chain elements must be determined
  │  and understood                                                          [S]
  ▼
Cyber-risk management obligation
  │  CAF A4 — systematic management of risks to N&IS supporting essential
  │  functions, assessed by the CA via the CAF return / audit                [S]
  ▼
Expected monitoring / assurance
  │  Ofgem: supplier-criticality assessment across stability, access and
  │  influence, impact and propagation — consistent and repeatable, applied
  │  proportionately, NOT a composite score                        [S, CONSULTATION]
  │  Ofgem NIS Security Assurance Guidance: approved-supplier and
  │  accreditation-equivalence expectations                                  [S]
  ▼
Where Soterius contributes
     A consent-free, repeatable, timestamped external hygiene observation of a
     supplier's internet-facing estate — usable as ONE input to the
     "impact and propagation" and general-hygiene dimensions.
     NOT usable for: access and influence, supplier stability, internal controls,
     OT exposure, or any criticality determination.
```

**Honest weakness in this chain.** Ofgem's criticality dimensions are dominated by
*relationship* factors (what access does this supplier have; what would propagate)
which are **invisible to external observation**. Soterius contributes to the *hygiene*
question — "is this supplier competently run at its boundary?" — which is a real but
secondary input. Overstating this is the most likely commercial failure mode.

---

## 12. Critical-supplier legislation — current status (Stage 9)

> ### PROPOSED — NOT YET IN FORCE (as at 2026-09-03)

**Cyber Security and Resilience (Network and Information Systems) Bill.**

**Parliamentary progress [S]:**

| Stage | Date |
|---|---|
| Introduced, House of Commons | 12 November 2025 |
| Commons second reading | 6 January 2026 |
| Commons committee stage | February 2026 |
| Commons stages completed | 16 June 2026 |
| Entered House of Lords | 17 June 2026 |
| Lords second reading | 14 July 2026 |
| Lords committee stage commencing | 1 September 2026 |
| Report stage, third reading, ping-pong, Royal Assent | **Not yet occurred** |

Royal Assent is expected later in 2026 **[S]**. Bill page: `bills.parliament.uk/bills/4035`.
A legislative consent memorandum was laid before the Northern Ireland Assembly
(15 December 2025) **[S]**.

**Proposed critical-supplier regime [S]:**

- Regulators would gain power to **designate critical suppliers** to essential and
  digital services, so that the most important suppliers become subject to mandatory
  cyber requirements.
- **Designation conditions (cumulative):** the supplier provides goods or services
  **directly** to an OES, RDSP or relevant managed service provider regulated by the
  **same regulator** considering designation; and disruption is likely to have a
  significant impact on the economy or day-to-day functioning of society in the whole
  or any part of the UK — covering both direct service disruption and cyber risk
  introduced by the supplier's own systems.
- **Effect of designation:** statutory cyber-security requirements and duties to manage
  and reduce risk, with detail to be set in **secondary legislation** developed through
  further consultation; regulators to have powers to inspect, enforce and fine.
- **Due process:** formal written notice; right to make representations; right of
  appeal to the **First-tier Tribunal**.
- The Bill also addresses **relevant managed service providers** and **relevant digital
  service providers** as categories **[S]**.

**Implementation:** phased. Most operational obligations will not take effect on Royal
Assent; key requirements are to be brought into force through secondary legislation
after further consultation, with full implementation not expected until around 2028
**[S, partly secondary-source]**.

**Mandatory labelling rule.** Every Soterius reference to critical-supplier
designation must be marked **PROPOSED / NOT YET IN FORCE**. Presenting it as a current
obligation would be a misrepresentation to a prospect and is prohibited (§14).

**UNRESOLVED:** whether the Bill has progressed beyond Lords committee stage since the
sources consulted; whether any provision has been commenced. **Re-check the Bill page
before any external use of this section.**

---

## 13. Claims Soterius could defensibly make

*Approved subject to the verification worklist in §17. Every one of these is capped by
the evidence-access limitation in the banner.*

**Framework-relevance claims (approved):**

1. ✅ "Soterius provides continuous external observations relevant to boundary-security
   and cyber-resilience outcomes assessed under the NCSC Cyber Assessment Framework,
   which Ofgem and the Drinking Water Inspectorate use in supervising energy and water
   operators of essential services."
2. ✅ "Soterius evidence is relevant to asset-management (CAF A3) and vulnerability-
   management (CAF B4.d) outcomes for an organisation's internet-facing estate."
3. ✅ "Soterius observations can form one input to an operator's own CAF
   self-assessment. They do not constitute a CAF assessment."

**Capability claims (approved):**

4. ✅ "Soterius continuously observes externally visible security configuration across
   a defined domain estate, with per-observation provenance and explicit
   observed/absent/not-observed/error outcomes."
5. ✅ "Soterius observes only what is externally visible. It has no view of internal
   networks, operational technology, or the systems that deliver an essential function."
6. ✅ "Soterius provides repeatable, comparable external hygiene observations of
   suppliers without requiring supplier consent, access or instrumentation."

**Market-context claims (approved, with care):**

7. ✅ "The NCSC retired its Web Check and Mail Check services on 31 March 2026, stating
   that External Attack Surface Management products now perform effectively the same
   function, and recommended that organisations adopt a commercial EASM product.
   Soterius observes an overlapping signal set." — **Approved only in this
   third-person form.** It is a statement about the market, not about Soterius.
8. ✅ "Email authentication controls such as DMARC, SPF and DKIM are recommended by the
   NCSC as good practice. They are not mandated by UK utilities cyber-security
   regulation." — approved *because* it is the conservative statement.

**Supplier claims (approved, narrowly):**

9. ✅ "Ofgem has consulted on supply-chain security guidance for the energy sector
   that anticipates consistent and repeatable supplier assessment. Soterius provides
   one repeatable evidence input to such assessment." — must carry
   **[consultation stage]**.

**Required accompanying disclaimers** (at least one, wherever CAF or NIS is named):

- Soterius does not assess, certify or determine compliance with NIS or the CAF.
- CAF assessment is a matter of expert judgement; Soterius provides evidence, not
  judgement **[S]**.
- Whether any organisation is an Operator of Essential Services is determined by
  thresholds and designation, not by sector.

---

## 14. Claims Soterius must NOT make

### 14.1 The seven statements put for adjudication — all REJECTED

| # | Statement | Verdict | Why |
|---|---|---|---|
| 1 | "Soterius proves NIS compliance." | ❌ **REJECTED** | NIS reg. 10 is an outcome duty assessed by a competent authority **[S]**. No external observation can prove it. "Proves" is unsupportable in any framing. |
| 2 | "DMARC is mandatory under NIS." | ❌ **REJECTED — FACTUALLY FALSE** | NIS names no technical control **[S]**. No utilities regulator instrument identified names DMARC. This is the single most damaging available false claim. |
| 3 | "Passing Soterius means an organisation is CAF compliant." | ❌ **REJECTED** | "CAF compliant" is not a real status; CAF is an assessment framework of contributing outcomes assessed by expert judgement **[S]**. Soterius covers a small external fraction. |
| 4 | "Soterius provides a complete CAF assessment." | ❌ **REJECTED** | Soterius touches a minority of principles, none completely, and none of Objectives A1/B2/B6/D1 at all. |
| 5 | "All utilities companies are legally required to use DMARC." | ❌ **REJECTED — FACTUALLY FALSE** | Two independent falsehoods: no DMARC requirement, and most utilities companies are not even OES (thresholds: 250,000 customers, 2 GW, 200,000 people) **[S]**. |
| 6 | "All suppliers to utilities are subject to NIS." | ❌ **REJECTED — FACTUALLY FALSE** | Suppliers are not OES. Designation of critical suppliers is **proposed, not in force**, would be regulator-specific, direct-supply-only and threshold-bound **[S]**. |
| 7 | "Soterius can certify an OES as secure." | ❌ **REJECTED** | Soterius is not a certification body, operates no accredited scheme, and observes no internal or OT systems. "Secure" is not a certifiable external property. |

### 14.2 Additional prohibited claims identified by this research

| Statement | Verdict | Why |
|---|---|---|
| "Soterius supports CAF C1 Security Monitoring." | ❌ **REJECTED** | C1 is internal detection of adverse activity **[S]**. Terminological fallacy. |
| "Soterius provides proactive security event discovery / threat hunting (C2)." | ❌ **REJECTED** | Soterius discovers no events and hunts nothing. Also cites a superseded C2 title **[S]**. |
| "The NCSC recommends Soterius." / "NCSC-recommended approach." | ❌ **REJECTED** | NCSC recommended a **product category**, named no vendor **[S]**. |
| "Soterius replaces NCSC Mail Check / Web Check." | ❌ **REJECTED** | Implies succession or endorsement. Permitted form is §13 claim 7 only. |
| "Soterius discovers your entire external attack surface." | ❌ **REJECTED** | Soterius observes a **known** domain estate. Completeness cannot be claimed. |
| "This supplier is high-risk / tier 1 / critical" from Soterius data. | ❌ **REJECTED** | Ofgem's framework expressly disclaims composite scoring and automated classification **[S]**; criticality turns on access and influence, invisible externally. |
| "Under the Cyber Security and Resilience Act, your suppliers must…" | ❌ **REJECTED** | **Not an Act.** Lords committee stage as at 2026-09-03 **[S]**. |
| "Your DKIM is missing / you do not use DKIM." | ❌ **REJECTED** as stated | Absence is unprovable — non-enumerable selector namespace. Permitted: "no DKIM key was found across probe set *v*." |
| "Soterius shows you are non-compliant." | ❌ **REJECTED** | The duty is *proportionate* **[S]**; an operator may lawfully not deploy a given control. A Soterius negative is not a compliance finding. |
| "Telecoms operators must comply with NIS." | ❌ **REJECTED — FACTUALLY FALSE** | Reg. 8(1A) prevents PECN/PECS designation as OES **[S]**. |
| "Soterius signals map directly to CAF requirements." | ❌ **REJECTED** | **Zero** DIRECT relationships were found. "Directly" is prohibited vocabulary. |

### 14.3 Prohibited vocabulary

Never, in any utilities-sector material: *proves · certifies · guarantees · ensures
compliance · compliant · directly required · mandated · complete assessment ·
NCSC-approved · regulator-approved · attack surface (unqualified by "known estate") ·
non-compliant.*

---

## 15. Commercial relevance assessment (Stage 11)

*Regulatory relevance and willingness to pay are assessed separately, as required. No
market demand is asserted beyond what the evidence supports.*

### 15.1 Regulated utility operators themselves

- **Regulatory driver:** NIS reg. 10 **[S]**; CAF returns to Ofgem/DWI; DWI's universal
  annual CAF return and 2023–24 audit of every water company, with two legal notices
  issued **[S]**; Ofgem NIS Guidance v3.0 that OES "must have regard to" **[S]**.
- **Soterius relevance:** external evidence for A3 and B4.d; a repeatable artefact for
  the annual return.
- **Strength: MEDIUM.** *Regulatory relevance is HIGH; commercial strength is capped by
  three facts:* the population is small (OES only, above high thresholds); these
  organisations already run mature security programmes and may already hold EASM; and
  Soterius covers a narrow slice of what a CAF return needs.
- **Key limitation:** an operator's CAF exposure is dominated by OT, internal
  monitoring and governance — none of which Soterius sees. Soterius is a small
  supporting input to a large assurance exercise, and will be priced as such.

### 15.2 Monitoring suppliers on behalf of regulated operators

- **Regulatory driver:** CAF A3 dependency identification and A4 **[S]**; Ofgem's
  supply-chain consultation with its "consistent and repeatable" framing **[S]**;
  Ofgem's approved-supplier/accreditation-equivalence expectations **[S]**;
  prospectively the CSR Bill's critical-supplier regime **[PROPOSED]** **[S]**.
- **Soterius relevance:** the natural fit. Consent-free, repeatable, comparable across
  many suppliers — precisely where operators lack telemetry.
- **Strength: HIGH.** The strongest case in the package: an active regulatory workstream
  (Ofgem, 2026), a large N (each operator has many suppliers), and a genuine capability
  gap.
- **Key limitation:** Ofgem disclaims composite scoring and automated classification
  **[S]**, so the product must be evidence-shaped, not score-shaped; and external
  hygiene does not address the access-and-influence dimension that actually drives
  criticality. Also unresolved: whether the guidance was finalised in August 2026.

### 15.3 Insurers and brokers covering utilities

- **Regulatory driver:** **none identified in this package.** No UK utilities
  cyber-insurance regulatory driver was researched or evidenced.
- **Soterius relevance:** external hygiene signals are a plausible underwriting and
  portfolio-monitoring input, and the regulatory environment raises the salience of
  utilities cyber risk generally.
- **Strength: LOW** *on the evidence in this package.* This is a rating of the
  **regulatory** case only. It is **not** a statement that the insurance market is
  unattractive — that question was not researched and no market evidence was gathered.
- **Key limitation:** any insurance case must rest on underwriting economics, not on
  the regulatory chain assembled here. Assessing it requires separate work.

### 15.4 Suppliers wanting to demonstrate external cyber hygiene

- **Regulatory driver:** anticipation of the CSR Bill critical-supplier regime
  **[PROPOSED]** **[S]**; present-day commercial pressure from operators' A4 processes
  **[S]**; Ofgem's approved-supplier framing **[S]**.
- **Soterius relevance:** a supplier can hold externally verifiable evidence of its own
  boundary hygiene ahead of being asked.
- **Strength: MEDIUM.** Real driver, but demand is anticipatory: the Bill is not law,
  full implementation is not expected until around 2028 **[S, partly secondary]**, and
  suppliers rarely buy against future regulation until a customer demands it.
- **Key limitation:** the buying trigger is a customer questionnaire, not the
  regulation. **Do not sell to suppliers on the basis that the Bill obliges them —
  it does not, yet.**

### 15.5 Regulatory / assurance benchmarking datasets

- **Regulatory driver:** DWI holds annual CAF returns across all in-scope water
  companies **[S]**; Ofgem operates sector-wide NIS supervision **[S]** and has stated
  an intent for its supply-chain guidance to evolve with operational experience and
  stakeholder feedback **[S]**.
- **Soterius relevance:** a consistent, longitudinal, methodologically stable external
  baseline across a sector is something no individual operator can produce and
  regulators currently lack.
- **Strength: MEDIUM.**
- **Key limitation:** **regulatory relevance and willingness to pay diverge most
  sharply here.** Regulators are poor commercial customers, procurement is slow, and
  publishing comparative sector data creates naming risk with the very organisations
  Soterius would sell to. Treat as credibility and positioning value, not revenue.

### 15.6 Summary

| Segment | Regulatory driver strength | Commercial strength (regulatory case only) |
|---|---|---|
| Regulated operators | HIGH | **MEDIUM** |
| Supplier monitoring for operators | HIGH | **HIGH** |
| Insurers / brokers | Not evidenced | **LOW** (regulatory case only; market case unassessed) |
| Suppliers self-demonstrating | MEDIUM (anticipatory) | **MEDIUM** |
| Benchmarking datasets | MEDIUM | **MEDIUM** |

**Overall.** The regulatory environment **does** strengthen the commercial case, but
not where it might be assumed. It strengthens **supplier assurance** most, **operator
self-assessment** moderately, and **email-security positioning** least — which is the
inverse of the intuitive ordering.

---

## 16. Regulatory evidence-graph recommendation (Stage 12)

**Recommendation only. No schema, migration or production change is proposed, and none
was made.**

### 16.1 The non-negotiable separation

The package's central modelling requirement is that these never share a class:

```
FACT           "Organisation X is an Ofgem-regulated electricity distributor."
               Verifiable against a register. True or false. Cite and move on.

INTERPRETATION "DMARC posture is STRONGLY_SUPPORTIVE evidence relevant to
               requirement Y."
               An argued position, version-bound, framework-bound, revisable,
               and (per this package) frequently WRONG if inflated.
```

Collapsing these would let an interpretation inherit the epistemic status of a
register lookup. Given that the CAF is guidance rather than statute, that Ofgem's
supply-chain guidance is at consultation, and that the CSR Bill is not law, the
interpretation layer here is **unusually volatile** — three of the package's key
anchors could change within twelve months.

### 16.2 Proposed shape

Two disjoint subgraphs, sharing no edge type.

**Subgraph 1 — Regulatory FACT (same epistemic class as the existing Repository Authority):**

```
Organisation ──regulated-as {regime, regulator, role, from, to}──▶ RegulatoryStatus
Organisation ──supplies {relationship, since}──────────────────▶ Organisation
Organisation ──designated-oes {sector, sub_sector, threshold_basis}▶ OESDesignation
(any of the above) ──supported-by──▶ Source
```

Properties: append-only, deterministic, citable, each edge carrying `Source`. This is
the existing Repository Authority discipline extended — merge by strong identifiers,
never by shared domain.

**Subgraph 2 — Regulatory INTERPRETATION (a distinct class, never merged):**

```
Signal ──relevant-to {
            relationship_class,     -- DIRECT | STRONGLY_SUPPORTIVE | INDIRECT
                                    --        | NO_MATERIAL_RELATIONSHIP
            confidence,             -- HIGH | MEDIUM | LOW
            reasoning_ref,          -- the §6.4-style chain, mandatory
            limitations_ref,        -- mandatory; an assertion with no stated
                                    -- limitation is malformed
            framework_version,      -- e.g. "CAF v4.0 (2025-08-04)"
            legal_status,           -- LEGISLATION | REGULATOR_GUIDANCE
                                    --   | NATIONAL_GUIDANCE | CONSULTATION
                                    --   | PROPOSED_NOT_IN_FORCE
            evidence_provenance,    -- PRIMARY_VERIFIED | SEARCH_CORROBORATED
                                    --   | MODEL_UNVERIFIED
            asserted_at, asserted_by, supersedes
          }──▶ RegulatoryRequirement

RegulatoryRequirement ──defined-in──▶ Source
```

### 16.3 Design rules the eventual implementation should adopt

1. **No edge may join the two subgraphs.** An interpretation may *reference* an
   Organisation, never assert a fact about it.
2. **`legal_status` is mandatory and un-defaulted.** The distinction between
   legislation, regulator guidance, national guidance, consultation and proposed law is
   the package's core discipline; a nullable field would erode it within one release.
3. **`evidence_provenance` is mandatory.** This package would be entirely
   `SEARCH_CORROBORATED` / `MODEL_UNVERIFIED`. That must be visible downstream, not
   buried in a document banner.
4. **`framework_version` is mandatory.** C2's rename between v3.x and v4.0 **[S]** is
   the worked example of why: an unversioned mapping silently rots.
5. **Interpretations are versioned and superseded, never updated in place** — matching
   the platform's append-only observation discipline.
6. **A relationship class of DIRECT should require elevated authority** (an
   explicit ratification step). This package found zero; a system that makes DIRECT
   cheap to assert will accumulate false ones.
7. **`limitations_ref` must be non-null.** Every row in §7 has real limitations; an
   interpretation without them is not a weaker claim, it is a malformed one.
8. **Do not derive a composite regulatory score.** Ofgem's stated position on
   composite scoring and automated classification **[S]** applies to exactly this
   temptation.

---

## 17. Source catalogue

**Retrieval status: NONE of the following was retrieved directly. All hosts were
blocked by the session egress policy (see banner). URLs were surfaced via search;
titles and dates are as reported by the search index and are NOT independently
verified.**

### 17.1 Legislation (primary — ALL UNRETRIEVED)

| Source | Title | URL | Date | Status |
|---|---|---|---|---|
| legislation.gov.uk | The Network and Information Systems Regulations 2018 (SI 2018/506) | `legislation.gov.uk/uksi/2018/506` | 2018 | **BLOCKED** |
| legislation.gov.uk | NIS Regulations 2018, Schedule 2 | `legislation.gov.uk/uksi/2018/506/schedule/2` | 2018 | **BLOCKED** |
| legislation.gov.uk | NIS (Amendment) Regulations 2018 (SI 2018/629) | `legislation.gov.uk/uksi/2018/629/made` | 2018 | **BLOCKED** |
| legislation.gov.uk | NIS (Amendment etc.) (EU Exit) Regulations 2019 (SI 2019/653) | `legislation.gov.uk/uksi/2019/653` | 2019 | **BLOCKED** |
| legislation.gov.uk | NIS (Amendment etc.) (EU Exit) (No. 2) Regulations 2019 (SI 2019/1444) | `legislation.gov.uk/uksi/2019/1444/made` | 2019 | **BLOCKED** |
| legislation.gov.uk | NIS (Amendment and Transitional Provision etc.) Regulations 2020 (SI 2020/1245) | `legislation.gov.uk/uksi/2020/1245/made` | 2020 | **BLOCKED** |
| legislation.gov.uk | Communications Act 2003, s.105A (version as at 2021-11-17) | `legislation.gov.uk/ukpga/2003/21/section/105A/2021-11-17` | 2021 | **BLOCKED** |
| legislation.gov.uk | Electronic Communications (Security Measures) Regulations 2022 — explanatory memorandum | `legislation.gov.uk/uksi/2022/933/pdfs/uksiem_20220933_en.pdf` | 2022 | **BLOCKED** |

### 17.2 NCSC (framework and guidance — ALL UNRETRIEVED)

| Title | URL | Date | Status |
|---|---|---|---|
| Cyber Assessment Framework (collection) | `ncsc.gov.uk/collection/cyber-assessment-framework` | — | **BLOCKED** |
| Cyber Assessment Framework 4.0 (PDF) | `ncsc.gov.uk/files/NCSC-Cyber-Assessment-Framework-4.0.pdf` | 2025-08-04 **[S]** | **BLOCKED** |
| CAF v4.0 — record of changes | `ncsc.gov.uk/files/Cyber-Assessment-Framework-Record-of-changes-v4_0.pdf` | 2025-08-04 **[S]** | **BLOCKED** |
| CAF v4.0 released in response to growing threat (blog) | `ncsc.gov.uk/blog-post/caf-v4-0-released-in-response-to-growing-threat` | 2025 | **BLOCKED** |
| Principle A3 Asset Management | `ncsc.gov.uk/collection/cyber-assessment-framework/caf-objective-a-managing-security-risk/principle-a3-asset-management` | — | **BLOCKED** |
| Principle A4 Supply Chain | `…/caf-objective-a-managing-security-risk/principle-a4-supply-chain` | — | **BLOCKED** |
| Principle B4 System Security | `…/caf-objective-b/principle-b4-system-security` | — | **BLOCKED** |
| Principle B5 Resilient networks and systems | `…/caf-objective-b/principle-b5-resilient-networks-and-systems` | — | **BLOCKED** |
| Principle C1 Security monitoring | `…/caf-objective-c-detecting-cyber-security-events/principle-c1-security-monitoring` | — | **BLOCKED** |
| Principle C2 Threat Hunting | `…/caf-objective-c-detecting-cyber-security-events/principle-c2-threat-hunting` | — | **BLOCKED** |
| Introduction to the CAF | `ncsc.gov.uk/collection/cyber-assessment-framework/introduction-to-caf` | — | **BLOCKED** |
| Email security and anti-spoofing (collection) | `ncsc.gov.uk/collection/email-security-and-anti-spoofing` | — | **BLOCKED** |
| Vulnerability Disclosure Toolkit v2 | `ncsc.gov.uk/files/NCSC-Vulnerability-disclosure-Toolkit-v2.pdf` | — | **BLOCKED** |
| NCSC to retire Web Check and Mail Check | `ncsc.gov.uk/blog-post/retiring-mail-check-web-check` | retirement 2026-03-31 **[S]** | **BLOCKED** |
| Protecting internet-facing services on public service CNI | `ncsc.gov.uk/blog-post/protecting-internet-facing-services-public-service-cni` | — | **BLOCKED** |
| Managing Public Domain Names | `ncsc.gov.uk/guidance/managing-public-domain-names` | — | **BLOCKED** |
| CAF v3.2 (superseded — do not rely on) | `ncsc.gov.uk/static-assets/documents/cyber-assessment-framework-v3.2.pdf` | 2024-04-15 | **BLOCKED / SUPERSEDED** |
| CAF v1.0 (superseded — do not rely on) | `ncsc.gov.uk/files/NCSC_CAF_1.pdf` | 2018-10-31 | **BLOCKED / SUPERSEDED** |

### 17.3 Ofgem (ALL UNRETRIEVED)

| Title | URL | Date | Status |
|---|---|---|---|
| **NIS Guidance for Downstream Gas and Electricity OES in GB, v3.0** | `ofgem.gov.uk/sites/default/files/2026-01/NIS_Guidance_for_Downstream_Gas_and_Electricity_Operators_of_Essential_Services_in_GB_v3.0.pdf` | updated 2026-01-14 **[S]** | **BLOCKED — PRIORITY 1** |
| **Supply Chain Security: Proposed Guidance (consultation)** | `ofgem.gov.uk/sites/default/files/2026-06/Supply%20Chain%20proposed%20guidance%20consultation.pdf` | 2026-06; closed 2026-06-26 **[S]** | **BLOCKED — PRIORITY 2** |
| NIS Supplementary Guidance and CAF Overlay for DGE Sector | `ofgem.gov.uk/sites/default/files/2024-02/NIS%20Supplementary%20Guidance%20and%20CAF%20Overlay%20for%20DGE%20Sector_TLPWhite.pdf` | 2024-02 | **BLOCKED — PRIORITY 3** |
| NIS Security Assurance Guidance (Concept) for DGE (OFG1164) | `ofgem.gov.uk/sites/default/files/2025-07/Ofgem-NIS-Security-Assurance-Guidance-Concept-for-DGE-Sector.pdf` | 2025-07 | **BLOCKED** |
| NIS Enforcement Guidelines and Penalty Policy | `ofgem.gov.uk/sites/default/files/2022-12/NIS%20Enforcement%20Guidelines%20and%20Penalty%20Policy%2020221669742648165.pdf` | 2022-12 | **BLOCKED** |
| RIIO-2 Cyber Resilience Guidelines | `ofgem.gov.uk/sites/default/files/docs/2020/04/riio2_cyber_resilience_guidelines.pdf` | 2020-04 | **BLOCKED** |
| Ofgem CA Guidance for DGE GB v1.0 | `ofgem.gov.uk/sites/default/files/2022-04/ofgem_ca_guidance_for_dge_gb_v1.0_final.pdf` | 2022-04 | **BLOCKED / likely superseded by v3.0** |
| Cybersecurity (landing page) | `ofgem.gov.uk/energy-regulation/technology-and-innovation/cybersecurity` | — | **BLOCKED** |

### 17.4 Drinking Water Inspectorate (ALL UNRETRIEVED)

| Title | URL | Status |
|---|---|---|
| The Network and Information Systems (NIS) Regulations 2018 | `dwi.gov.uk/the-network-and-information-systems-nis-regulations-2018/` | **BLOCKED — PRIORITY 4** |
| Enforcement Policy — Network and Information Systems | `dwi.gov.uk/what-we-do/nis_enforcement_policy/` | **BLOCKED** |
| Drinking Water 2024 — Chief Inspector's report, NIS section (England) | `dwi.gov.uk/what-we-do/annual-report/drinking-water-2024/…/network-information-systems-nis/` | **BLOCKED** |
| Drinking Water 2024 — NIS section (Wales) | `dwi.gov.uk/what-we-do/annual-report/drinking-water-2024/…/nis/` | **BLOCKED** |
| Security and Emergencies (SEMD) | `dwi.gov.uk/semd/` | **BLOCKED** |

### 17.5 GOV.UK / DSIT / Parliament (ALL UNRETRIEVED)

| Title | URL | Status |
|---|---|---|
| CSR (NIS) Bill: factsheets | `gov.uk/government/publications/cyber-security-and-resilience-network-and-information-systems-bill-factsheets` | **BLOCKED** |
| — Summary of the Bill | `…/summary-of-the-bill` | **BLOCKED** |
| — Designating critical suppliers | `…/designating-critical-suppliers` | **BLOCKED — PRIORITY 5** |
| — Relevant managed service providers | `…/relevant-managed-service-providers` | **BLOCKED** |
| — Relevant digital service providers | `…/relevant-digital-service-providers` | **BLOCKED** |
| — Power to direct regulated entities | `…/power-to-direct-regulated-entities` | **BLOCKED** |
| Cyber security and resilience policy statement | `gov.uk/government/publications/cyber-security-and-resilience-bill-policy-statement/…` | **BLOCKED** |
| NIS — Guidance for Competent Authorities | `assets.publishing.service.gov.uk/media/5ad87a14ed915d32a65dbe9b/NIS_-_Guidance_for_Competent_Authorities.pdf` | **BLOCKED** |
| CSR (NIS) Bill — bill page and stages | `bills.parliament.uk/bills/4035` | **BLOCKED — PRIORITY 6** |
| NI Assembly legislative consent memorandum | `niassembly.gov.uk/globalassets/legislative-consent/documents/20251215_lcm_…pdf` | **BLOCKED** |
| Hansard — Lords 2R, 14 July 2026 | `hansard.parliament.uk/Lords/2026-07-14/debates/…` | **BLOCKED** |

### 17.6 Ofcom (ALL UNRETRIEVED)

| Title | URL | Status |
|---|---|---|
| Guidance for OES in the digital infrastructure sector | `ofcom.org.uk/siteassets/…/ofcom-guidance-for-oes-in-the-digital-infrastructure-sector.pdf` | **BLOCKED** |
| Guidance on resilience requirements under ss.105A–105D Communications Act 2003 | `ofcom.org.uk/siteassets/…/ofcom-guidance-on-resilience-requirements-…pdf` | **BLOCKED** |
| Network and Service Resilience Guidance for Communications Providers | `ofcom.org.uk/siteassets/…/network-and-service-resilience-guidance-for-communications-providerspdf` | published 2026-06-16 | **BLOCKED** |

### 17.7 Standards

| Reference | Note |
|---|---|
| RFC 9116 (security.txt) | Named by the NCSC Vulnerability Disclosure Toolkit **[S]**. Informational, not a standards-track requirement, and not incorporated into any UK utilities instrument identified. |

### 17.8 Discovery-only sources — NOT evidence

Consultancy, law-firm, vendor and encyclopaedia material (Mayer Brown, PwC, Travers
Smith, TLT, Taylor Wessing, Lewis Silkin, Marsh, Osborne Clarke, Brodies, Darktrace,
e2e-assure, Longwall, TXP, CSA, DigitalXRAID, Northdoor, Kiteworks, Lexology,
LexisNexis, Practical Law, Wikipedia, arXiv preprints, complexdiscovery,
compliancehub.wiki, LGA, ICO NIS guide) surfaced during discovery. **None is treated
as authoritative anywhere in this package**, in accordance with Stage 2. Where such a
source was the only support for a proposition, the proposition is marked
**[S, secondary/discovery only]** or **UNRESOLVED** (e.g. the ~2028 full-implementation
date; the sub-2 GW generation gap commentary).

### 17.9 Verification worklist — required to promote this package

Retrieve, from an environment with unrestricted egress, in priority order:

1. **Ofgem NIS Guidance for DGE OES in GB v3.0** (2026-01-14) — the operative energy CA
   instrument. Search specifically for: email/DMARC/SPF/DKIM; TLS/certificates; DNS;
   attack surface; external/internet-facing; supply chain; continuous monitoring.
2. **Ofgem Supply Chain Security guidance** — confirm whether the August 2026 outcome
   was published and whether the guidance is now final. Confirm verbatim the
   "not a composite score / automated classification" wording, on which §11.2, §14.2
   and §16.3(8) all depend.
3. **Ofgem NIS Supplementary Guidance and CAF Overlay for DGE** — the sector's CAF
   interpretation; determines whether any Soterius signal is named at sector level.
4. **DWI NIS pages and Chief Inspector's report** — confirm the 39 contributing
   outcomes, the annual return mechanism, and any supply-chain content.
5. **CSR (NIS) Bill — bills.parliament.uk/bills/4035** — confirm current stage as at
   date of use. §12 is time-sensitive and will go stale.
6. **CAF v4.0 PDF** — capture verbatim IGP text for **A3, A4, B3, B4 (esp. B4.d), C1,
   C2**. This is what converts §7's paraphrases into quotable evidence and would allow
   several MEDIUM confidences to move to HIGH. **Specifically resolve whether B3
   addresses data in transit** (rows 7.4 and 7.7 depend on it) and whether any IGP
   mentions email authentication (§8).
7. **NIS Regulations 2018, regs. 8 and 10 and Schedules 1–2** — exact wording of the
   reg. 10 duty, the reg. 8(1A) telecoms exclusion, the Schedule 1 competent-authority
   table, and all Schedule 2 thresholds including gas and electricity system operation
   (both UNRESOLVED in §3.2).
8. **Electronic Communications (Security Measures) Regulations 2022** — the 16 measures.
   The only identified UK regime plausibly naming specific technical controls; a
   genuinely DIRECT relationship, if one exists anywhere, is most likely here.
9. **NCSC Vulnerability Disclosure Toolkit v2** — confirm the three-component structure
   and the security.txt characterisation on which §7.10's STRONGLY_SUPPORTIVE rests.

---

## 18. Unknowns and unresolved legal questions

| # | Question | Status | Impact if resolved against current assumption |
|---|---|---|---|
| 1 | Does Ofgem's NIS Guidance v3.0 name any specific technical control Soterius observes? | **UNRESOLVED** | Could raise one or more signals to DIRECT for energy — the single highest-value unknown |
| 2 | Was Ofgem's supply-chain guidance finalised in August 2026? | **UNRESOLVED** | Changes §11/§15.2 from consultation-stage to operative guidance |
| 3 | Do CAF v4.0 IGPs mention email authentication? | **UNRESOLVED** | Could raise DMARC/SPF/DKIM from INDIRECT to STRONGLY_SUPPORTIVE |
| 4 | Does CAF B3 address data in transit, and in what terms? | **UNRESOLVED** | Rows 7.4 (MTA-STS) and 7.7 (TLS) depend on it |
| 5 | Electricity system operation and gas sub-sector thresholds | **UNRESOLVED** | Affects addressable-market sizing in energy |
| 6 | Is sewerage an in-scope essential service? | **UNRESOLVED** | Affects water market sizing |
| 7 | Ofwat's role in cyber assurance (PR24 and successors) | **UNRESOLVED** | A second, independent water-sector driver if it exists |
| 8 | DWI SEMD cyber content | **UNRESOLVED** | A second water-sector regulatory anchor if it exists |
| 9 | Northern Ireland and devolved competent-authority arrangements | **UNRESOLVED** | Geographic scope of any claim |
| 10 | Do the Electronic Communications (Security Measures) Regulations 2022 name controls Soterius observes? | **UNRESOLVED** | Most likely location of a genuine DIRECT relationship anywhere in this package |
| 11 | Current parliamentary stage of the CSR Bill | **TIME-SENSITIVE** | §12 must be re-verified before any external use |
| 12 | Will critical-supplier designation reach Soterius's supplier prospects? | **UNRESOLVED — inherently** | Depends on secondary legislation not yet drafted; designation is regulator-by-regulator and direct-supply-only **[S]** |
| 13 | Have Ofgem/DWI adopted any NCSC guidance (email, vulnerability disclosure) into their regimes? | **UNRESOLVED, currently assessed as no** | Would raise security.txt and the email signals materially |
| 14 | Whether CAF's 39 DWI-returned contributing outcomes correspond to CAF v4.0 or an earlier version | **UNRESOLVED** | Version-mapping risk in any water-sector claim |

---

## 19. The central question, answered in plain English

> **Can Soterius legitimately position its continuous external boundary-signal
> monitoring as supporting UK utilities-sector NIS/CAF cyber-security and supply-chain
> assurance obligations, and if so, exactly how far can that claim go?**

**Yes — but considerably less far than the marketing instinct would take it, and along
a different axis than expected.**

**1. Direct regulatory obligations: none.** Nothing Soterius measures is required by
name by any UK utilities cyber-security law or regulator instrument found in this
research. The statutory duty is to take *appropriate and proportionate* measures
**[S]** — deliberately technology-neutral. Zero of the 14 areas were classified
DIRECT. Any claim that a Soterius signal is mandated, required, or directly mapped to
a regulation is **false**, and "DMARC is mandatory under NIS" is the most damaging
version of it.

**2. Evidence supportive of regulatory outcomes: yes, genuinely, in five places.**
TLS, certificate security, security.txt, external attack-surface visibility, and
supplier external monitoring are **STRONGLY_SUPPORTIVE** — they produce real evidence
bearing on outcomes that Ofgem and the DWI actually assess: CAF **A3** (know your
assets, including supporting infrastructure), **B4/B4.d** (manage known
vulnerabilities so they cannot adversely affect essential functions), and **A4**
(systematically manage supply-chain risk) **[S]**. That is a defensible, honest,
saleable position. Soterius can say it provides *continuous external observations
relevant to boundary-security outcomes expected under the CAF*. It cannot say more.

**3. Useful external assurance: this is the real product.** Soterius's genuine value
in utilities is not that it maps to a rule, but that it answers a question operators
struggle to answer with their own tooling — *what does our (and our suppliers')
internet-facing estate actually look like today, and has it changed?* Two facts make
this commercially live rather than theoretical: the NCSC retired its own Web Check and
Mail Check on 31 March 2026 and told organisations to buy commercial EASM instead
**[S]**; and Ofgem spent 2026 consulting on supplier-security guidance that expressly
seeks *consistent and repeatable* supplier assessment **[S]**. Supplier assurance is
the strongest commercial case in this package.

**4. Compliance claims that cannot be made: all of them.** Soterius cannot prove NIS
compliance, cannot certify an operator, cannot produce or complete a CAF assessment,
and cannot support CAF C1 or C2 — those concern detecting adversary activity *inside*
the operator's systems, which Soterius never sees **[S]**. It cannot claim to discover
a complete attack surface, since it observes a *known* domain estate. It cannot score
or tier suppliers, because Ofgem's own framework disclaims composite scoring and
automated classification **[S]**. And it must not invoke the Cyber Security and
Resilience Bill's critical-supplier regime as a present obligation: as at 3 September
2026 the Bill was at Lords committee stage and is **not law** **[S]**.

**The one-sentence version.** *Soterius provides continuous, repeatable external
evidence relevant to how UK utilities and their suppliers are assessed — it does not
provide compliance, assessment, or assurance, and the moment it claims to, the claim
becomes false.*

**And the caveat that governs everything above:** this package could not read a single
primary source. It is a sound analytical framework built on corroborated summaries.
Before any of it reaches a customer, insurer or regulator, §17.9 must be discharged.

---

*End of REG-UTIL-001. Research package only — not a governed authority, not registered,
not integrated. No production system, schema, dataset, scheduler, scoring, cohort or
monitoring configuration was read for modification or modified. No organisations or
domains were acquired. No scanning was performed.*
