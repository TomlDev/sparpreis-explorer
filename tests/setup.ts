// Runs before test modules are imported. Point the DB at a throwaway file and
// force the offline mock provider so no network is touched.
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";

process.env.DATABASE_PATH = path.join(os.tmpdir(), `bf-test-${randomUUID()}.db`);
process.env.RAIL_PROVIDER = "mock";
process.env.AUTH_SECRET = "test-secret";
process.env.APP_PASSWORD = "test-pw";
process.env.TZ = "Europe/Berlin";
