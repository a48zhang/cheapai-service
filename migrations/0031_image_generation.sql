-- Image models share administrator-owned channels and their group permissions.
CREATE TABLE image_models (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL,
  channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE RESTRICT,
  upstream_model TEXT NOT NULL,
  price_units INTEGER NOT NULL CHECK (typeof(price_units)='integer' AND price_units BETWEEN 0 AND 9007199254740991),
  sizes_json TEXT NOT NULL CHECK (json_valid(sizes_json) AND json_type(sizes_json)='array'),
  quality TEXT NOT NULL,
  response_format TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active','disabled')),
  version INTEGER NOT NULL CHECK (version>=1),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE image_generations (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  operation_id TEXT NOT NULL,
  model_id TEXT NOT NULL REFERENCES image_models(id) ON DELETE RESTRICT,
  model_name TEXT NOT NULL,
  group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE RESTRICT,
  prompt TEXT NOT NULL,
  size TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('generating','completed','failed','unknown')),
  error TEXT,
  price_units INTEGER NOT NULL CHECK (typeof(price_units)='integer' AND price_units BETWEEN 0 AND 9007199254740991),
  price_snapshot TEXT NOT NULL CHECK (json_valid(price_snapshot)),
  billing_status TEXT NOT NULL CHECK (billing_status IN ('unbilled','pending','settled')),
  asset_key TEXT,
  media_type TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  UNIQUE(user_id,operation_id)
);
CREATE INDEX idx_image_generations_history ON image_generations(user_id,created_at DESC,id DESC);
