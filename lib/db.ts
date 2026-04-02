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
}
