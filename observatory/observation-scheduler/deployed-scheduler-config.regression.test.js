'use strict';

// OBS-103 WP-1 — Deployed scheduler configuration regression guard.
//
// Pins the ONE authoritative production scheduler deployment configuration
// (the Railway scheduler deploy config at the repo root) to the canonical
// full-coverage drain-worker command and 15-minute cron.
//
// This test FAILS if the deployed startCommand or cron is reverted to the
// superseded manual/pilot model — run-scheduler-cli.js, an --org pilot scope,
// or the old "30 8,9" / "30 8" / "30 11" wake crons — or if the manual
// entrypoint (run-scheduler-cli.js) is ever set as ANY Railway startCommand.
// It is the automated backstop for the Phase 1B audit's config-drift finding:
// a silent revert to the 5-organisation dual-wake scheduler can no longer pass
// CI.
//
// Deliberately a .test.js file: obs103-scope.structural.test.js forbids
// referencing the Railway config / cronSchedule inside the scheduler's NON-test
// source, so this deploy-config assertion must live in test code — the only
// place permitted to read the deployment config.

const fs = require('fs');
const path = require('path');
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const REPO_ROOT = path.join(__dirname, '..', '..');
const SCHEDULER_CONFIG_NAME = 'railway.observation-scheduler.json';
const SCHEDULER_CONFIG = path.join(REPO_ROOT, SCHEDULER_CONFIG_NAME);

// The single source of truth for what production runs. Changing the deployed
// command/cron requires a deliberate edit to BOTH the config file AND these
// constants — which is exactly the point: an accidental or silent revert to the
// old command/cron cannot pass CI without also editing this guard on purpose.
const CANONICAL_START_COMMAND =
  'node observatory/observation-scheduler/run-drain-cli.js '
  + '--production --max-states-per-run 1500 --page-size 250 --concurrency 8 --runtime-budget-ms 720000';
const CANONICAL_CRON = '*/15 * * * *';

// Superseded schedules that must never reappear (Phase 1B audit §C / §I).
const OBSOLETE_CRONS = ['30 8,9 * * *', '30 8 * * *', '30 11 * * *'];

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function railwayConfigNames() {
  return fs.readdirSync(REPO_ROOT).filter((n) => /^railway.*\.json$/.test(n));
}

describe('OBS-103 deployed scheduler configuration (WP-1 regression guard)', () => {
  test('the scheduler deploy config exists and has a deploy block', () => {
    assert.ok(fs.existsSync(SCHEDULER_CONFIG), `${SCHEDULER_CONFIG_NAME} must exist at the repo root`);
    const cfg = readJson(SCHEDULER_CONFIG);
    assert.ok(cfg.deploy && typeof cfg.deploy === 'object', 'config must have a deploy block');
  });

  test('deployed startCommand is EXACTLY the canonical drain-worker command', () => {
    const { deploy } = readJson(SCHEDULER_CONFIG);
    assert.equal(
      deploy.startCommand,
      CANONICAL_START_COMMAND,
      'deployed scheduler startCommand has drifted from the canonical full-coverage drain-worker command',
    );
  });

  test('deployed startCommand uses the drain worker, full population, canonical budgets', () => {
    const cmd = readJson(SCHEDULER_CONFIG).deploy.startCommand;
    assert.match(cmd, /run-drain-cli\.js/, 'must invoke the drain worker (run-drain-cli.js)');
    assert.match(cmd, /--production\b/, 'must pass --production');
    assert.match(cmd, /--max-states-per-run 1500\b/, 'max-states-per-run must be 1500');
    assert.match(cmd, /--page-size 250\b/, 'page-size must be 250');
    assert.match(cmd, /--concurrency 8\b/, 'concurrency must be 8');
    assert.match(cmd, /--runtime-budget-ms 720000\b/, 'runtime-budget-ms must be 720000');
    assert.doesNotMatch(cmd, /run-scheduler-cli\.js/, 'must NOT deploy the manual run-scheduler-cli.js');
    assert.doesNotMatch(cmd, /\s--org\b/, 'must NOT be scoped to specific organisations (--org)');
  });

  test('deployed cron is the 15-minute schedule, not a superseded wake schedule', () => {
    const { deploy } = readJson(SCHEDULER_CONFIG);
    assert.equal(deploy.cronSchedule, CANONICAL_CRON, 'cron must be the 15-minute schedule');
    for (const obsolete of OBSOLETE_CRONS) {
      assert.notEqual(deploy.cronSchedule, obsolete, `cron must not revert to the superseded "${obsolete}"`);
    }
  });

  test('deploy topology is a single, always-restarting replica', () => {
    const { deploy } = readJson(SCHEDULER_CONFIG);
    assert.equal(deploy.numReplicas, 1, 'scheduler must run a single replica');
    assert.equal(deploy.restartPolicyType, 'ON_FAILURE');
  });

  test('the manual entrypoint (run-scheduler-cli.js) is NEVER a Railway startCommand', () => {
    const names = railwayConfigNames();
    assert.ok(
      names.includes(SCHEDULER_CONFIG_NAME),
      'the scheduler deploy config must be present among the railway configs',
    );
    for (const name of names) {
      const cfg = readJson(path.join(REPO_ROOT, name));
      const cmd = (cfg.deploy && cfg.deploy.startCommand) || '';
      assert.doesNotMatch(
        cmd,
        /run-scheduler-cli\.js/,
        `${name} must not deploy the manual run-scheduler-cli.js as a service startCommand`,
      );
    }
  });

  test('exactly ONE railway config deploys the observation scheduler, and it is the drain worker', () => {
    const schedulerConfigs = railwayConfigNames().filter((name) => {
      const cmd = (readJson(path.join(REPO_ROOT, name)).deploy || {}).startCommand || '';
      return /observatory\/observation-scheduler\//.test(cmd);
    });
    assert.deepEqual(
      schedulerConfigs,
      [SCHEDULER_CONFIG_NAME],
      'exactly one railway config may deploy the observation scheduler',
    );
    const cmd = readJson(path.join(REPO_ROOT, schedulerConfigs[0])).deploy.startCommand;
    assert.match(cmd, /run-drain-cli\.js/, 'the sole scheduler deploy config must run the drain worker');
  });
});
