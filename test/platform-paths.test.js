import assert from "node:assert/strict";
import test from "node:test";

import { expandHomePath, getPlatformPaths, resolveUserPath } from "../src/platform-paths.js";

test("Windows paths use AppData and Documents", () => {
  const paths = getPlatformPaths({
    platform: "win32",
    home: "C:\\Users\\alayna",
    env: {
      APPDATA: "D:\\Roaming",
      LOCALAPPDATA: "E:\\Local",
    },
  });

  assert.equal(paths.configDir, "D:\\Roaming\\Poke Gate");
  assert.equal(paths.dataDir, "E:\\Local\\Poke Gate");
  assert.equal(paths.documentsDir, "C:\\Users\\alayna\\Documents");
  assert.equal(paths.agentsDir, "D:\\Roaming\\Poke Gate\\agents");
});

test("Unix paths retain XDG compatibility", () => {
  const paths = getPlatformPaths({
    platform: "linux",
    home: "/home/alayna",
    env: { XDG_CONFIG_HOME: "/config", XDG_DATA_HOME: "/data" },
  });

  assert.equal(paths.configDir, "/config/poke-gate");
  assert.equal(paths.dataDir, "/data/poke-gate");
  assert.equal(paths.documentsDir, "/home/alayna/Documents");
});

test("path overrides support redirected Documents folders", () => {
  const paths = getPlatformPaths({
    platform: "win32",
    home: "C:\\Users\\alayna",
    env: { POKE_GATE_DOCUMENTS_DIR: "D:\\OneDrive\\Documents" },
  });

  assert.equal(paths.documentsDir, "D:\\OneDrive\\Documents");
});

test("home expansion and relative paths use the selected fallback", () => {
  assert.equal(expandHomePath("~/notes", "/Users/demo"), "/Users/demo/notes");
  assert.equal(expandHomePath("~\\notes", "C:\\Users\\demo"), "C:\\Users\\demo\\notes");
  assert.equal(
    resolveUserPath("projects/demo", {
      paths: { homeDir: "/Users/demo" },
      fallback: "/Users/demo/Documents",
    }),
    "/Users/demo/Documents/projects/demo",
  );
});
