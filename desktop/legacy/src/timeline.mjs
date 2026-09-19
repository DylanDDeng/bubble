export function contentText(content) {
  if (typeof content === "string") return content;
  return Array.isArray(content)
    ? content.map((p) => (p.type === "text" ? p.text : "[图片]")).join("\n")
    : "";
}
function resultStatus(result) {
  if (result?.status === "cancelled") return "interrupted";
  return result?.isError ||
    ["timeout", "blocked", "command_error"].includes(result?.status)
    ? "error"
    : "done";
}
export function historyRows(history) {
  const rows = [];
  const add = (row) => rows.push({ id: `history-${rows.length}`, ...row });
  for (const message of history) {
    if (message.role === "user")
      add({ kind: "user", text: contentText(message.content) });
    if (message.role === "assistant") {
      if (message.reasoning)
        add({ kind: "reasoning", text: message.reasoning });
      if (message.content) add({ kind: "assistant", text: message.content });
      for (const call of message.toolCalls ?? [])
        add({
          kind: "tool",
          id: call.id,
          name: call.name,
          input:
            typeof call.arguments === "string"
              ? call.arguments
              : JSON.stringify(call.arguments),
          // A persisted call without a result is not proof of successful execution.
          status: "interrupted",
        });
      if (message.error) add({ kind: "error", text: message.error.message });
    }
    if (message.role === "tool") {
      const tool = rows.findLast(
        (r) => r.kind === "tool" && r.id === message.toolCallId,
      );
      if (tool) {
        tool.output = contentText(message.content);
        tool.status = message.isError ? "error" : "done";
      }
    }
  }
  return rows;
}
export function appendEvent(previous, event) {
  const rows = previous.slice();
  const at = event.at;
  if (event.type === "turn_start")
    rows.push({ kind: "step", id: `step-${rows.length}` });
  if (event.type === "text_delta" || event.type === "reasoning_delta") {
    const kind = event.type === "text_delta" ? "assistant" : "reasoning";
    const last = rows.at(-1);
    if (last?.kind === kind && !last.final)
      rows[rows.length - 1] = { ...last, text: last.text + event.content };
    else rows.push({ kind, id: `${kind}-${rows.length}`, text: event.content });
  }
  if (event.type === "tool_start" || event.type === "tool_end") {
    // Tool ids need only be unique within a user turn.
    const userIndex = rows.findLastIndex((row) => row.kind === "user");
    const index = rows.findLastIndex(
      (row, i) => i > userIndex && row.kind === "tool" && row.id === event.id,
    );
    const row = {
      ...(rows[index] ?? { kind: "tool", id: event.id, name: event.name }),
      ...(event.type === "tool_start"
        ? {
            input: JSON.stringify(event.args, null, 2),
            status: "running",
            startedAt: at,
          }
        : {
            output: contentText(event.result?.content),
            status: resultStatus(event.result),
            endedAt: at,
          }),
    };
    if (index < 0) rows.push(row);
    else rows[index] = row;
  }
  if (event.type === "tool_update") {
    const index = rows.findLastIndex(
      (row) => row.kind === "tool" && row.id === event.id,
    );
    if (index >= 0) rows[index] = { ...rows[index], update: event.update };
  }
  if (
    event.type === "turn_end" &&
    event.willContinue === false &&
    rows.at(-1)?.kind === "assistant"
  )
    rows[rows.length - 1] = { ...rows.at(-1), final: true };
  if (event.type === "provider_retry")
    rows.push({
      kind: "notice",
      id: `notice-${rows.length}`,
      text: `连接重试 ${event.attempt}/${event.maxAttempts} · ${event.reason}`,
    });
  if (event.type === "input_applied")
    rows.push({ kind: "user", id: `input-${event.id}`, text: event.content });
  return rows;
}
export function finishRows(rows, turn = {}) {
  const userIndex = rows.findLastIndex((row) => row.kind === "user");
  return rows.map((row, i) =>
    i === userIndex
      ? { ...row, ...turn }
      : i > userIndex && row.status === "running"
        ? { ...row, status: "interrupted", endedAt: turn.endedAt }
        : row,
  );
}
export function snapshotRows(snapshot) {
  const rows = snapshot.events.reduce(
    appendEvent,
    historyRows(snapshot.history),
  );
  let userIndexInHistory = -1;
  for (let i = 0; i < rows.length; i++) {
    if (rows[i].kind !== "user") continue;
    userIndexInHistory++;
    const metadata = snapshot.turns?.find(
      (turn) => turn.userIndex === userIndexInHistory,
    );
    if (metadata) rows[i] = { ...rows[i], ...metadata };
  }
  const userIndex = rows.findLastIndex((row) => row.kind === "user");
  if (snapshot.turn && userIndex >= 0)
    rows[userIndex] = { ...rows[userIndex], ...snapshot.turn };
  return rows;
}
