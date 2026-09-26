-- TLS certificates of the monitored hosts, from certificate transparency
-- logs: the latest expiry of a valid certificate covering each host. A
-- latest certificate close to expiry means renewal has stalled.
CREATE TABLE tls_certs (
  host TEXT PRIMARY KEY,
  not_after TEXT,
  issuer TEXT,
  checked_at TEXT NOT NULL,
  error TEXT
);
