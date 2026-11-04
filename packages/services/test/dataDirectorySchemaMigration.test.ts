import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { rewriteDatabasePaths } from "../src/data-directory/sqlite.js";

describe("数据迁移使用已发布的 workspace/project 键格式", () => {
  it("长路径按已有 80 字符 project ID 规则迁移，多个身份截断冲突时拒绝", async () => {
    const temporary = await mkdtemp(join(tmpdir(), "zcode-migration-project-"));
    const path = join(temporary, "sessions.sqlite");
    try {
      const db = new DatabaseSync(path);
      db.exec("CREATE TABLE session(id TEXT PRIMARY KEY,project_id TEXT,directory TEXT)");
      db.prepare("INSERT INTO session VALUES (?,?,?)").run(
        "alpha",
        "users-example-.zcode-workspace-alpha",
        "/Users/example/.zcode/workspace/alpha",
      );
      db.prepare("INSERT INTO session VALUES (?,?,?)").run(
        "beta",
        "users-example-.zcode-workspace-beta",
        "/Users/example/.zcode/workspace/beta",
      );
      db.close();
      expect(() =>
        rewriteDatabasePaths(path, [
          { source: "/Users/example/.zcode", target: "/Volumes/" + "x".repeat(100) + "/.zcode" },
        ]),
      ).toThrow("DATA_DIRECTORY_SOURCE_CONFLICT");
      const unchanged = new DatabaseSync(path);
      expect(
        unchanged.prepare("SELECT project_id FROM session WHERE id='alpha'").get()?.project_id,
      ).toBe("users-example-.zcode-workspace-alpha");
      unchanged.exec("DELETE FROM session WHERE id='beta'");
      unchanged.close();
      rewriteDatabasePaths(path, [
        { source: "/Users/example/.zcode", target: "/Volumes/" + "x".repeat(100) + "/.zcode" },
      ]);
      const migrated = new DatabaseSync(path, { readOnly: true });
      try {
        expect(migrated.prepare("SELECT project_id FROM session").get()?.project_id).toBe(
          "volumes-" + "x".repeat(72),
        );
      } finally {
        migrated.close();
      }
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  });

  it("迁移真实 POSIX project ID、输入历史、权限与手动排序，保留 session ID 和正文", async () => {
    const temporary = await mkdtemp(join(tmpdir(), "zcode-migration-schema-"));
    const path = join(temporary, "sessions.sqlite");
    const oldDirectory = "/Users/example/.zcode/workspace/default";
    const newDirectory = "/Volumes/Data/ZCode/.zcode/workspace/default";
    const oldProjectId = "users-example-.zcode-workspace-default";
    const newProjectId = "volumes-data-zcode-.zcode-workspace-default";
    try {
      const db = new DatabaseSync(path);
      db.exec(
        "CREATE TABLE session(id TEXT PRIMARY KEY, project_id TEXT, directory TEXT, path TEXT, workspace_id TEXT); CREATE TABLE permission(project_id TEXT PRIMARY KEY, mode TEXT); CREATE TABLE input_history(id TEXT PRIMARY KEY, project_id TEXT, attachments TEXT); CREATE TABLE task_group_view_node_orders(node_type TEXT, node_key TEXT, sort_order INTEGER, PRIMARY KEY(node_type,node_key)); CREATE TABLE part(id TEXT PRIMARY KEY,data TEXT); CREATE TABLE message(id TEXT PRIMARY KEY,data TEXT)",
      );
      db.prepare("INSERT INTO session VALUES (?,?,?,?,NULL)").run(
        "stable-session-id",
        oldProjectId,
        oldDirectory,
        oldDirectory,
      );
      db.prepare("INSERT INTO permission VALUES (?,?)").run(oldProjectId, "ask");
      db.prepare("INSERT INTO input_history VALUES (?,?,?)").run(
        "input-1",
        oldProjectId,
        JSON.stringify([{ type: "file", path: oldDirectory + "/attachment.txt" }]),
      );
      db.prepare("INSERT INTO task_group_view_node_orders VALUES ('task',?,42)").run(
        JSON.stringify([oldDirectory, "stable-session-id"]),
      );
      db.prepare("INSERT INTO part VALUES (?,?)").run(
        "part-1",
        JSON.stringify({ type: "text", text: oldDirectory }),
      );
      const opaqueInput = { directory: oldDirectory, localPath: oldDirectory + "/not-a-reference" };
      db.prepare("INSERT INTO part VALUES (?,?)").run(
        "tool-1",
        JSON.stringify({
          type: "tool",
          state: {
            input: opaqueInput,
            metadata: { serialization: { artifactPath: oldDirectory + "/result.json" } },
          },
        }),
      );
      db.prepare("INSERT INTO message VALUES (?,?)").run(
        "message-1",
        JSON.stringify({
          role: "assistant",
          path: { cwd: oldDirectory, root: oldDirectory },
          structured: opaqueInput,
        }),
      );
      db.close();
      rewriteDatabasePaths(path, [
        { source: "/Users/example/.zcode", target: "/Volumes/Data/ZCode/.zcode" },
      ]);
      const migrated = new DatabaseSync(path, { readOnly: true });
      try {
        expect(migrated.prepare("SELECT id,project_id,directory FROM session").get()).toEqual({
          id: "stable-session-id",
          project_id: newProjectId,
          directory: newDirectory,
        });
        expect(migrated.prepare("SELECT * FROM permission").get()).toEqual({
          project_id: newProjectId,
          mode: "ask",
        });
        expect(migrated.prepare("SELECT project_id,attachments FROM input_history").get()).toEqual({
          project_id: newProjectId,
          attachments: JSON.stringify([{ type: "file", path: newDirectory + "/attachment.txt" }]),
        });
        expect(
          migrated.prepare("SELECT node_key,sort_order FROM task_group_view_node_orders").get(),
        ).toEqual({
          node_key: JSON.stringify([newDirectory, "stable-session-id"]),
          sort_order: 42,
        });
        expect(
          JSON.parse(
            String(migrated.prepare("SELECT data FROM part WHERE id='part-1'").get()?.data),
          ).text,
        ).toBe(oldDirectory);
        const tool = JSON.parse(
          String(migrated.prepare("SELECT data FROM part WHERE id='tool-1'").get()?.data),
        );
        expect(tool.state.input).toEqual(opaqueInput);
        expect(tool.state.metadata.serialization.artifactPath).toBe(newDirectory + "/result.json");
        const message = JSON.parse(
          String(migrated.prepare("SELECT data FROM message").get()?.data),
        );
        expect(message.structured).toEqual(opaqueInput);
        expect(message.path).toEqual({ cwd: newDirectory, root: newDirectory });
      } finally {
        migrated.close();
      }
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  });
});
