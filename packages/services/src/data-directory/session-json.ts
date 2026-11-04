type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : undefined;
}

/** 只遍历已发布 schema 的路径载体；工具 input、模型 structured 和未知 entry 都属于原始内容。 */
export function mapStoredSessionReferences(
  table: string,
  value: unknown,
  map: (value: unknown) => unknown,
  entryType?: string,
): unknown {
  if (table === "input_history") return map(value);
  const record = asRecord(value);
  if (!record) return value;
  if (table === "message") {
    return record.role === "assistant" && record.path
      ? { ...record, ...asRecord(map({ path: record.path })) }
      : value;
  }
  if (table === "session_input") {
    return record.attachments ? { ...record, attachments: map(record.attachments) } : value;
  }
  if (table === "session_entry") {
    return ["runtime/workspace_checkpoint", "runtime/workspace_file_rewind"].includes(
      entryType ?? "",
    )
      ? map(value)
      : value;
  }
  if (table !== "part") return value;
  if (record.type === "file") return map(value);
  if (record.type !== "tool") return value;
  const state = asRecord(record.state);
  if (!state) return value;
  const metadata = asRecord(state.metadata);
  const nextMetadata = metadata ? { ...metadata } : undefined;
  if (metadata && nextMetadata) {
    if (metadata.serialization) nextMetadata.serialization = map(metadata.serialization);
    const display = asRecord(metadata.display);
    // display 里的 MCP structuredContent 是第三方原始结果；file_diff 才有受管的 filePath。
    if (display?.kind === "file_diff") nextMetadata.display = map(display);
    for (const key of ["artifactPath", "outputFile", "taskOutputFile"]) {
      if (typeof metadata[key] === "string")
        Object.assign(nextMetadata, asRecord(map({ [key]: metadata[key] })));
    }
  }
  return {
    ...record,
    state: {
      ...state,
      ...(state.attachments ? { attachments: map(state.attachments) } : {}),
      ...(nextMetadata ? { metadata: nextMetadata } : {}),
    },
  };
}
