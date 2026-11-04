import {
  acquireDataDirectoryUsageLease,
  initializeDataDirectory,
} from "@zcode/shared/data-directory";

await initializeDataDirectory();
await acquireDataDirectoryUsageLease({ role: "desktop-host" });
await import("./index.js");
