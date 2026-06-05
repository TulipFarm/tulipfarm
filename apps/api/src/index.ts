import { config } from "dotenv";
import Fastify from "fastify";
import { connectDb } from "./db";
import { runDataMigrations } from "./migrate";
import { runSoulMigrations } from "./soul/migrate";

// Load .env.local (symlinked from root by setup script)
config({ path: ".env.local" });

// Validate required environment variables at startup
function validateEnvironment() {
  const required = ["MONGODB_URI", "REDIS_URL", "SOUL_PATH", "ENCRYPTION_KEY", "JWT_SECRET"];
  const missing = required.filter((key) => !process.env[key]);

  if (missing.length > 0) {
    console.error(`❌ Missing required environment variables: ${missing.join(", ")}`);
    console.error("📋 Copy .env.local.example to .env.local and generate secrets:");
    console.error("   openssl rand -base64 32");
    process.exit(1);
  }

  // Validate ENCRYPTION_KEY is 32 bytes base64
  try {
    const encKey = Buffer.from(process.env.ENCRYPTION_KEY as string, "base64");
    if (encKey.length !== 32) {
      console.error(`❌ ENCRYPTION_KEY must be 32 bytes base64 (got ${encKey.length} bytes)`);
      console.error("   Generate with: openssl rand -base64 32");
      process.exit(1);
    }
  } catch (err) {
    console.error("❌ ENCRYPTION_KEY is not valid base64");
    process.exit(1);
  }
}

validateEnvironment();

const app = Fastify({ logger: true });

app.get("/health", async () => ({ status: "ok" }));

const port = Number.parseInt(process.env.PORT || "4001", 10);

async function boot() {
  try {
    const { db } = await connectDb();
    await runSoulMigrations(process.env.SOUL_PATH as string);
    await runDataMigrations(db);
  } catch (error) {
    console.error(`❌ Boot failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }

  app.listen({ port, host: "0.0.0.0" }, (err) => {
    if (err) {
      app.log.error(err);
      process.exit(1);
    }
  });
}

boot();
