import { config } from "dotenv";

export function loadEnvironmentFile(path = ".env") {
  const result = config({ path, override: false });
  if (!result.error) return { loaded: true as const };
  if ((result.error as NodeJS.ErrnoException).code === "ENOENT") return { loaded: false as const };
  throw result.error;
}
