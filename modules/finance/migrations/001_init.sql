CREATE TABLE IF NOT EXISTS erp_snapshots (
  key        TEXT PRIMARY KEY,
  payload    TEXT NOT NULL,
  synced_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS erp_daily (
  date           TEXT PRIMARY KEY,
  revenue        REAL NOT NULL,
  paid_orders    INTEGER NOT NULL,
  registrations  INTEGER NOT NULL,
  company_share  REAL NOT NULL,
  programs       TEXT NOT NULL DEFAULT '[]',
  synced_at      INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS erp_period_totals (
  period         TEXT NOT NULL,
  from_date      TEXT NOT NULL,
  to_date        TEXT NOT NULL,
  revenue        REAL NOT NULL,
  paid_orders    INTEGER NOT NULL,
  registrations  INTEGER NOT NULL,
  company_share  REAL NOT NULL,
  programs       TEXT NOT NULL DEFAULT '[]',
  synced_at      INTEGER NOT NULL,
  PRIMARY KEY (period, from_date)
);

CREATE TABLE IF NOT EXISTS pnl_whop_daily (
  date       TEXT PRIMARY KEY,
  gross      REAL NOT NULL,
  refunded   REAL NOT NULL,
  net        REAL NOT NULL,
  synced_at  INTEGER NOT NULL
);

-- Replaces the owner's dashboard_settings keys: pnl.settings.v1, profit.document.v1, profit.ads.v1
CREATE TABLE IF NOT EXISTS finance_kv (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
