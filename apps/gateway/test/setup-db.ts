// Imported FIRST by tests that statically import app modules: points the gateway at a throwaway database so
// tests can never write into the real data/gateway.db.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
process.env.GATEWAY_DB_PATH = join(mkdtempSync(join(tmpdir(), "gw-test-")), "t.db");
