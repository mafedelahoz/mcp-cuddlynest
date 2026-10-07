// One-off: lists tables and, for ones that look like Stays/Attractions,
// their columns — so we can map real fields before writing the query layer.
// Usage: npm run db:inspect   (reads .env at the project root)
import "dotenv/config";
import mysql from "mysql2/promise";

const { CUDDLYNEST_DB_HOST, CUDDLYNEST_DB_PORT, CUDDLYNEST_DB_USER, CUDDLYNEST_DB_PASSWORD, CUDDLYNEST_DB_NAME } =
  process.env;

if (!CUDDLYNEST_DB_HOST || !CUDDLYNEST_DB_USER || !CUDDLYNEST_DB_NAME) {
  console.error(
    "Missing DB env vars. Copy .env.example to .env and fill in CUDDLYNEST_DB_HOST / " +
      "CUDDLYNEST_DB_USER / CUDDLYNEST_DB_PASSWORD / CUDDLYNEST_DB_NAME first.",
  );
  process.exit(1);
}

const KEYWORDS = ["stay", "hotel", "propert", "listing", "attraction", "activity", "poi", "experience"];

const conn = await mysql.createConnection({
  host: CUDDLYNEST_DB_HOST,
  port: Number(CUDDLYNEST_DB_PORT || 3306),
  user: CUDDLYNEST_DB_USER,
  password: CUDDLYNEST_DB_PASSWORD,
  database: CUDDLYNEST_DB_NAME,
  connectTimeout: Number(process.env.CUDDLYNEST_DB_TIMEOUT_MS || 5000),
});

const [tables] = await conn.query(
  "SELECT table_name, table_rows FROM information_schema.tables WHERE table_schema = ? ORDER BY table_name",
  [CUDDLYNEST_DB_NAME],
);

console.log(`\n${tables.length} tables in ${CUDDLYNEST_DB_NAME}:\n`);
for (const t of tables) console.log(` - ${t.TABLE_NAME ?? t.table_name} (~${t.TABLE_ROWS ?? t.table_rows} rows)`);

const likely = tables
  .map((t) => t.TABLE_NAME ?? t.table_name)
  .filter((name) => KEYWORDS.some((k) => name.toLowerCase().includes(k)));

console.log(`\nLikely Stays/Attractions tables: ${likely.join(", ") || "(none matched by name, check the full list above)"}\n`);

for (const name of likely) {
  const [cols] = await conn.query(
    "SELECT column_name, data_type, is_nullable, column_key FROM information_schema.columns WHERE table_schema = ? AND table_name = ? ORDER BY ordinal_position",
    [CUDDLYNEST_DB_NAME, name],
  );
  console.log(`--- ${name} ---`);
  for (const c of cols) {
    const col = c.COLUMN_NAME ?? c.column_name;
    const type = c.DATA_TYPE ?? c.data_type;
    const key = c.COLUMN_KEY ?? c.column_key;
    console.log(`  ${col} : ${type}${key ? ` (${key})` : ""}`);
  }
  console.log();
}

await conn.end();
