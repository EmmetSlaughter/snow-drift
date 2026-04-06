import { neon } from '@neondatabase/serverless';

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL environment variable is not set');
}

export const sql = neon(process.env.DATABASE_URL);

/**
 * Idempotently create / migrate the schema. Safe to call on every request.
 */
export async function ensureSchema(): Promise<void> {
  // Drop the v1 forecast_snapshots table if it pre-dates the location_id column.
  // The old single-location data is no longer useful.
  await sql`
    DO $$
    BEGIN
      IF EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_name = 'forecast_snapshots'
      ) AND NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'forecast_snapshots'
          AND column_name = 'location_id'
      ) THEN
        DROP TABLE forecast_snapshots;
      END IF;
    END $$
  `;

  // Locations table — each unique (lat, lon) grid point.
  await sql`
    CREATE TABLE IF NOT EXISTS locations (
      id  SERIAL           PRIMARY KEY,
      lat DOUBLE PRECISION NOT NULL,
      lon DOUBLE PRECISION NOT NULL,
      UNIQUE (lat, lon)
    )
  `;

  // Forecast snapshots — one row per (location, source, valid_hour, cron_run).
  // Only non-zero snow rows are stored to keep storage manageable.
  await sql`
    CREATE TABLE IF NOT EXISTS forecast_snapshots (
      id          BIGSERIAL        PRIMARY KEY,
      fetched_at  TIMESTAMPTZ      NOT NULL DEFAULT NOW(),
      location_id INTEGER          NOT NULL REFERENCES locations (id),
      source      TEXT             NOT NULL,
      valid_time  TIMESTAMPTZ      NOT NULL,
      snow_cm     DOUBLE PRECISION NOT NULL DEFAULT 0
    )
  `;

  await sql`
    CREATE INDEX IF NOT EXISTS idx_snapshots_lookup
    ON forecast_snapshots (location_id, source, fetched_at)
  `;

  await sql`
    CREATE INDEX IF NOT EXISTS idx_snapshots_valid_time
    ON forecast_snapshots (valid_time)
  `;

  // Storms — one row per detected precipitation event per location.
  await sql`
    CREATE TABLE IF NOT EXISTS storms (
      id           SERIAL      PRIMARY KEY,
      location_id  INTEGER     NOT NULL REFERENCES locations (id),
      window_start TIMESTAMPTZ NOT NULL,
      window_end   TIMESTAMPTZ NOT NULL,
      detected_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;

  await sql`
    CREATE INDEX IF NOT EXISTS idx_storms_location
    ON storms (location_id, window_start)
  `;

  // NWS grid metadata — populated lazily on first snowy collect run per location.
  // nws_office = 'NONE' means the location has no NWS coverage (ocean, border edge, etc.)
  await sql`ALTER TABLE locations ADD COLUMN IF NOT EXISTS nws_office  VARCHAR(10)`;
  await sql`ALTER TABLE locations ADD COLUMN IF NOT EXISTS nws_grid_x  INTEGER`;
  await sql`ALTER TABLE locations ADD COLUMN IF NOT EXISTS nws_grid_y  INTEGER`;

  // Pre-aggregated map data — single row updated each cron run.
  // Replaces the heavy per-request query that scanned all forecast_snapshots.
  await sql`
    CREATE TABLE IF NOT EXISTS map_cache (
      id         INTEGER          PRIMARY KEY DEFAULT 1,
      fetched_at TIMESTAMPTZ      NOT NULL,
      data       JSONB            NOT NULL
    )
  `;
}
