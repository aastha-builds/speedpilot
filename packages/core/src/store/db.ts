import Database from 'better-sqlite3';
import { dirname } from 'node:path';
import { ensureDir } from '../util/paths.js';

export type DB = Database.Database;

/** Ordered migrations. Never edit a shipped migration; add a new one. */
export const MIGRATIONS: string[] = [
  // 1: data model from SPEC.md 1.3
  `
  CREATE TABLE sites (
    id TEXT PRIMARY KEY,
    platform TEXT NOT NULL CHECK (platform IN ('wordpress','shopify')),
    production_url TEXT NOT NULL,
    staging_url TEXT,
    config_json TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );
  CREATE TABLE runs (
    id TEXT PRIMARY KEY,
    site_id TEXT NOT NULL REFERENCES sites(id),
    type TEXT NOT NULL CHECK (type IN ('audit','backup','apply','verify','deploy','monitor','xray','baseline','restore','staging','rollback','simulate')),
    stage TEXT NOT NULL CHECK (stage IN ('local','staging','production')),
    tool_versions_json TEXT NOT NULL DEFAULT '{}',
    machine_json TEXT NOT NULL DEFAULT '{}',
    started_at TEXT NOT NULL,
    ended_at TEXT,
    status TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running','ok','failed','aborted')),
    dir TEXT NOT NULL
  );
  CREATE TABLE pages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id TEXT NOT NULL REFERENCES runs(id),
    url TEXT NOT NULL,
    template TEXT NOT NULL,
    device TEXT NOT NULL CHECK (device IN ('mobile','desktop')),
    run_index INTEGER NOT NULL,
    lighthouse_path TEXT,
    trace_path TEXT,
    screenshots_json TEXT NOT NULL DEFAULT '[]'
  );
  CREATE TABLE metrics (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id TEXT NOT NULL REFERENCES runs(id),
    url TEXT NOT NULL,
    device TEXT NOT NULL,
    source TEXT NOT NULL CHECK (source IN ('lab','psi','field','simulated')),
    name TEXT NOT NULL,
    median REAL,
    min REAL,
    max REAL,
    samples_json TEXT NOT NULL DEFAULT '[]'
  );
  CREATE TABLE findings (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES runs(id),
    check_id TEXT NOT NULL,
    urls_json TEXT NOT NULL DEFAULT '[]',
    evidence_json TEXT NOT NULL DEFAULT '{}',
    metric TEXT NOT NULL,
    estimated_gain_json TEXT NOT NULL DEFAULT '{}',
    tier TEXT NOT NULL,
    fix TEXT NOT NULL,
    root_cause TEXT,
    priority REAL NOT NULL DEFAULT 0
  );
  CREATE TABLE plans (
    id TEXT PRIMARY KEY,
    site_id TEXT NOT NULL REFERENCES sites(id),
    run_id TEXT REFERENCES runs(id),
    created_at TEXT NOT NULL,
    plan_json TEXT NOT NULL
  );
  CREATE TABLE changes (
    id TEXT PRIMARY KEY,
    plan_id TEXT NOT NULL REFERENCES plans(id),
    finding_ids_json TEXT NOT NULL DEFAULT '[]',
    tier TEXT NOT NULL,
    description TEXT NOT NULL,
    implementation TEXT,
    status TEXT NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed','approved','applied','kept','rolled_back')),
    before_json TEXT,
    after_json TEXT,
    verification_id TEXT,
    rollback_steps TEXT NOT NULL DEFAULT '',
    reason TEXT,
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );
  CREATE TABLE backups (
    id TEXT PRIMARY KEY,
    site_id TEXT NOT NULL REFERENCES sites(id),
    stage TEXT NOT NULL,
    type TEXT NOT NULL,
    location TEXT NOT NULL,
    checksums_json TEXT NOT NULL DEFAULT '{}',
    restore_tested INTEGER NOT NULL DEFAULT 0,
    restore_run_id TEXT,
    created_at TEXT NOT NULL
  );
  CREATE TABLE approvals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    plan_id TEXT NOT NULL,
    site_id TEXT NOT NULL,
    stage TEXT NOT NULL,
    items_json TEXT NOT NULL,
    approver TEXT NOT NULL,
    approved_at TEXT NOT NULL,
    approval_text TEXT NOT NULL
  );
  CREATE TABLE verifications (
    id TEXT PRIMARY KEY,
    run_id TEXT REFERENCES runs(id),
    site_id TEXT NOT NULL,
    stage TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('baseline','quick','full')),
    result TEXT NOT NULL CHECK (result IN ('PASS','FAIL')),
    checks_json TEXT NOT NULL,
    evidence_dir TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE recipes (
    id TEXT PRIMARY KEY,
    platform TEXT NOT NULL,
    target TEXT NOT NULL,
    recipe_json TEXT NOT NULL,
    confidence REAL NOT NULL DEFAULT 0
  );
  CREATE TABLE outcomes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    change_id TEXT NOT NULL,
    check_or_recipe_id TEXT NOT NULL,
    platform TEXT NOT NULL,
    target TEXT,
    target_version TEXT,
    simulated_gain_json TEXT,
    before_json TEXT,
    after_json TEXT,
    kept INTEGER NOT NULL,
    reason TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );
  CREATE TABLE xray_nodes (
    run_id TEXT NOT NULL,
    id TEXT NOT NULL,
    type TEXT NOT NULL,
    label TEXT NOT NULL,
    owner TEXT,
    data_json TEXT NOT NULL DEFAULT '{}',
    PRIMARY KEY (run_id, id)
  );
  CREATE TABLE xray_edges (
    run_id TEXT NOT NULL,
    src TEXT NOT NULL,
    dst TEXT NOT NULL,
    type TEXT NOT NULL,
    evidence TEXT NOT NULL,
    confidence REAL NOT NULL,
    data_json TEXT NOT NULL DEFAULT '{}'
  );
  CREATE INDEX idx_edges_run ON xray_edges(run_id, src);
  CREATE INDEX idx_findings_run ON findings(run_id);
  CREATE INDEX idx_metrics_run ON metrics(run_id, url, device);
  `,
  // 2: X-ray shadow mode (SPEC.md 15.10): every verdict is logged and later compared with what verification found
  `
  CREATE TABLE xray_verdicts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    site_id TEXT NOT NULL,
    run_id TEXT NOT NULL,
    change TEXT NOT NULL,
    change_type TEXT NOT NULL,
    verdict TEXT NOT NULL CHECK (verdict IN ('safe','unsafe','unknown')),
    confidence REAL NOT NULL,
    recipe TEXT,
    evidence_json TEXT NOT NULL DEFAULT '[]',
    outcome TEXT CHECK (outcome IN ('passed','failed')),
    outcome_reason TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );
  CREATE INDEX idx_xray_verdicts ON xray_verdicts(site_id, change);
  `,
];

export function openDb(file: string): DB {
  if (file !== ':memory:') ensureDir(dirname(file));
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  migrate(db);
  return db;
}

export function migrate(db: DB): number {
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)');
  const row = db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get() as { v: number | null };
  let current = row.v ?? 0;
  for (let v = current + 1; v <= MIGRATIONS.length; v++) {
    const sql = MIGRATIONS[v - 1]!;
    db.transaction(() => {
      db.exec(sql);
      db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)').run(v, new Date().toISOString());
    })();
    current = v;
  }
  return current;
}
