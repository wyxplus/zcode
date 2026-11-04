import {
  acquireDataDirectoryUsageLease,
  initializeDataDirectory,
} from "@zcode/shared/data-directory";

await initializeDataDirectory();
await acquireDataDirectoryUsageLease({ role: "desktop-scheduler" });
await import("./index.js");
