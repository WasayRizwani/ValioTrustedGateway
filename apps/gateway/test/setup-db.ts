// Imported FIRST by tests that statically import app modules: points the gateway at an isolated in-memory
// PostgreSQL instance (@electric-sql/pglite) so tests run fast in the sandbox without touching external DBs.
process.env.DATABASE_URL = "";
process.env.PGLITE_DATA_DIR = "memory://";
