import { rm } from "node:fs/promises";
for (const directory of ["dist", "apps/dashboard/src/generated"])
  await rm(directory, { recursive: true, force: true });
