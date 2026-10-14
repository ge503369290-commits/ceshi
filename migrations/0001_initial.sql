PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS app_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin', 'employee')),
  active INTEGER NOT NULL DEFAULT 1,
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);

CREATE TABLE IF NOT EXISTS audit_logs (
  id TEXT PRIMARY KEY,
  user_id TEXT,
  username TEXT NOT NULL,
  action TEXT NOT NULL,
  target TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_audit_logs_created_at ON audit_logs(created_at DESC);

CREATE TABLE IF NOT EXISTS industries (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS imports (
  id TEXT PRIMARY KEY,
  file_name TEXT NOT NULL,
  province TEXT NOT NULL,
  city TEXT NOT NULL,
  industry_id TEXT NOT NULL,
  industry_name TEXT NOT NULL,
  total_rows INTEGER NOT NULL,
  imported_rows INTEGER NOT NULL,
  duplicate_rows INTEGER NOT NULL,
  invalid_rows INTEGER NOT NULL,
  imported_at TEXT NOT NULL,
  FOREIGN KEY (industry_id) REFERENCES industries(id)
);

CREATE INDEX IF NOT EXISTS idx_imports_imported_at ON imports(imported_at DESC);
CREATE INDEX IF NOT EXISTS idx_imports_industry ON imports(industry_id);

CREATE TABLE IF NOT EXISTS merchants (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL DEFAULT '',
  phone TEXT NOT NULL,
  phone_key TEXT NOT NULL,
  address TEXT NOT NULL DEFAULT '',
  province TEXT NOT NULL,
  city TEXT NOT NULL,
  industry_id TEXT NOT NULL,
  import_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (industry_id) REFERENCES industries(id),
  FOREIGN KEY (import_id) REFERENCES imports(id) ON DELETE CASCADE,
  UNIQUE (province, city, industry_id, phone_key)
);

CREATE INDEX IF NOT EXISTS idx_merchants_scope ON merchants(province, city, industry_id);
CREATE INDEX IF NOT EXISTS idx_merchants_import ON merchants(import_id);
CREATE INDEX IF NOT EXISTS idx_merchants_industry ON merchants(industry_id);

CREATE TABLE IF NOT EXISTS export_records (
  id TEXT PRIMARY KEY,
  province TEXT NOT NULL,
  city TEXT NOT NULL,
  industry_name TEXT NOT NULL,
  record_count INTEGER NOT NULL,
  exported_at TEXT NOT NULL,
  user_id TEXT,
  username TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_export_records_exported_at ON export_records(exported_at DESC);
