-- 051_domain_discovery_pilot.sql
--
-- Domain Discovery Pilot (HMRC AML Brave domain-discovery pilot) — 7
-- append-only, idempotent tables. No foreign keys into organisations,
-- domains, scans, or any commercial_* table: this pilot is entirely
-- self-contained, read-only against Repository Authority and HMRC source
-- data, and produces no product-facing writes. Registered but NOT applied
-- to any live database as part of this pilot's implementation.

CREATE TABLE IF NOT EXISTS domain_discovery_pilot_candidates (
    id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    hmrc_registration_number    TEXT,
    business_name               TEXT NOT NULL,
    trading_name                TEXT,
    postcode                    TEXT,
    sample_rank                 INTEGER NOT NULL,
    derived_category            TEXT NOT NULL,
    name_ambiguity_class        TEXT NOT NULL,
    name_divergence_class       TEXT NOT NULL,
    entity_form_class           TEXT NOT NULL,
    postcode_completeness_class TEXT NOT NULL,
    region_class                TEXT NOT NULL,
    urban_rural_class           TEXT NOT NULL,
    floor_pass_selected         BOOLEAN NOT NULL DEFAULT FALSE,
    sampling_rule_version       TEXT NOT NULL,
    created_at                  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS domain_discovery_pilot_prefilter (
    id                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    candidate_id              UUID NOT NULL REFERENCES domain_discovery_pilot_candidates(id),
    hmrc_registration_number  TEXT,
    match_query_inputs        JSONB,
    ra_search_candidates      JSONB,
    classification            TEXT NOT NULL,
    matched_organisation_id   TEXT,
    matched_domain_status     TEXT,
    freshness_check           JSONB,
    final_brave_decision      TEXT NOT NULL,
    decision_reason           TEXT NOT NULL,
    prefilter_rule_version    TEXT NOT NULL,
    created_at                TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS domain_discovery_pilot_queries (
    id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    candidate_id           UUID NOT NULL REFERENCES domain_discovery_pilot_candidates(id),
    query_template_version TEXT NOT NULL,
    query_string           TEXT NOT NULL,
    brave_request_params   JSONB,
    brave_raw_response     JSONB,
    request_id             TEXT,
    status                 TEXT NOT NULL,
    retryable              BOOLEAN NOT NULL DEFAULT FALSE,
    executed_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS domain_discovery_pilot_search_results (
    id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    query_id           UUID NOT NULL REFERENCES domain_discovery_pilot_queries(id),
    rank               INTEGER,
    title              TEXT,
    snippet            TEXT,
    url                TEXT NOT NULL,
    source             TEXT,
    provider_metadata  JSONB,
    retrieved_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS domain_discovery_pilot_page_fetches (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    candidate_id      UUID NOT NULL REFERENCES domain_discovery_pilot_candidates(id),
    search_result_id  UUID REFERENCES domain_discovery_pilot_search_results(id),
    requested_url     TEXT NOT NULL,
    final_url         TEXT,
    status            INTEGER,
    content_type      TEXT,
    page_role         TEXT NOT NULL,
    raw_body          TEXT,
    fetched_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS domain_discovery_pilot_evidence (
    id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    candidate_id             UUID NOT NULL REFERENCES domain_discovery_pilot_candidates(id),
    page_fetch_id            UUID NOT NULL REFERENCES domain_discovery_pilot_page_fetches(id),
    company_number           TEXT,
    legal_name               TEXT,
    trading_name_found       TEXT,
    postcode_found           TEXT,
    address_found            TEXT,
    telephone_found          TEXT,
    principals               JSONB,
    category_consistency     BOOLEAN,
    extraction_rule_version  TEXT NOT NULL,
    extracted_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS domain_discovery_pilot_decisions (
    id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    candidate_id           UUID NOT NULL UNIQUE REFERENCES domain_discovery_pilot_candidates(id),
    decision_state         TEXT NOT NULL,
    score_total            INTEGER NOT NULL,
    score_breakdown        JSONB NOT NULL,
    matched_domain         TEXT,
    disqualifier_reason    TEXT,
    scoring_rule_version   TEXT NOT NULL,
    decided_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);
