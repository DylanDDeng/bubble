import type { ContentPart, ToolResult, UserMessage } from "../types.js";

/** All tool responses must precede the observation (valid for every provider). */
export function toolImageObservation(
  results: ToolResult[],
): UserMessage | null {
  const content: ContentPart[] = [];
  let bytes = 0;
  for (const result of results) {
    if (result.isError) continue;
    for (const image of result.images ?? []) {
      if (
        content.length >= 8 ||
        !["image/png", "image/jpeg"].includes(image.mimeType)
      )
        continue;
      if (
        typeof image.data !== "string" ||
        image.data.length > 4_000_000 ||
        !/^[a-zA-Z0-9+/]+={0,2}$/.test(image.data)
      )
        continue;
      const raw = Buffer.from(image.data, "base64");
      if (bytes + raw.length > 6_000_000) continue;
      if (
        image.mimeType === "image/png"
          ? raw.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a"
          : raw.subarray(0, 3).toString("hex") !== "ffd8ff"
      )
        continue;
      bytes += raw.length;
      content.push({
        type: "text",
        text: `Screenshot observation from the preceding tool result (not a new user request):\n${result.content.slice(0, 2000)}`,
      });
      content.push({
        type: "image_url",
        image_url: { url: `data:${image.mimeType};base64,${image.data}` },
      });
    }
  }
  return content.length ? { role: "user", content, toolObservation: true } : null;
}
