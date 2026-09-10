import { describe, expect, it } from "vitest";
import { PassThrough, Readable } from "node:stream";
import { runStreamJsonSession } from "../stream-json.js";
import type { AgentEvent } from "../types.js";
const message = (text: string) => JSON.stringify({ type: "user", request_id: text, message: { role: "user", content: text } });

describe("persistent stream-json session", () => {
  it("keeps one process session alive, streams events before completion, and runs turns sequentially", async () => {
    const input = new PassThrough(), output: Record<string, any>[] = [], history: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const done = runStreamJsonSession({ input, sessionId: "seat", model: "glm-5.3", write: m => output.push(m),
      run: async function* (text): AsyncGenerator<AgentEvent> {
        history.push(text); yield { type: "turn_start" } as AgentEvent;
        yield { type: "text_delta", content: history.join(",") };
        if (text === "one") await gate;
        yield { type: "turn_end" } as AgentEvent;
      } });
    input.write(message("one") + "\n");
    await new Promise(resolve => setImmediate(resolve));
    expect(output.some(m => m.type === "stream_event")).toBe(true);
    expect(output.some(m => m.type === "result")).toBe(false);
    input.end(message("two")); // final line without newline must be drained after the first turn
    await new Promise(resolve => setImmediate(resolve));
    expect(history).toEqual(["one"]);
    release(); await done;
    const results = output.filter(m => m.type === "result");
    expect(results.map(m => m.result)).toEqual(["one", "one,two"]);
    expect(results.map(m => m.request_id)).toEqual(["one", "two"]);
    expect(results.every(m => m.session_id === "seat" && !m.is_error)).toBe(true);
    expect(output.filter(m => m.subtype === "init")).toHaveLength(1);
  });

  it("rejects malformed and cross-session input and recovers after a failed turn", async () => {
    const output: Record<string, any>[] = [];
    const lines = ["{bad", JSON.stringify({type:"user",session_id:"other",message:{role:"user",content:"wrong"}}), message("fail"), message("ok")];
    await runStreamJsonSession({input: Readable.from([lines.join("\r\n")]),sessionId:"seat",model:"test",write:m=>output.push(m),
      run: async function* (text): AsyncGenerator<AgentEvent> {if(text==='fail')throw Error('provider failed');yield {type:'text_delta',content:text};}});
    expect(output.filter(m=>m.type==='result').map(m=>m.is_error)).toEqual([true,true,true,false]);
    expect(output.at(-1)?.result).toBe('ok');
  });

  it("accepts text blocks and bounds oversized incomplete input", async () => {
    const output: Record<string, any>[]=[];
    const options={sessionId:'seat',model:'test',write:(m:Record<string,unknown>)=>output.push(m),run:async function*(text:string):AsyncGenerator<AgentEvent>{yield {type:'text_delta',content:text};}};
    await runStreamJsonSession({...options,input:Readable.from([JSON.stringify({type:'user',message:{role:'user',content:[{type:'text',text:'hello'},{type:'text',text:'world'}]}})])});
    expect(output.at(-1)?.result).toBe('hello\nworld');
    await expect(runStreamJsonSession({...options,input:Readable.from(['x'.repeat(1024*1024+1)])})).rejects.toThrow('1 MiB');
  });
});
