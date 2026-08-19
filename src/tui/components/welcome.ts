import { createRequire } from "node:module";
import chalk from "chalk";
import stringWidth from "string-width";
import { truncateToWidth, type Component } from "@bubblebrain-ai/pi-tui";
import { displayModel } from "../../provider-registry.js";
import { isThinkingOnlyModel, isThinkingToggleModel } from "../../provider-transform.js";

export interface WelcomeBannerData {
  cwd: string;
  session?: string;
  model: string;
  provider?: string;
  thinking?: string;
  updateNotice?: string;
}

const require = createRequire(import.meta.url);
const PACKAGE_VERSION = readPackageVersion();
const COMPACT_CAT = [
  " ▄  ▄ ",
  "██████",
  "█ ██ █",
  "██████",
  " ▀  ▀ ",
];

/** Width-responsive Bubble welcome, rendered from live app state. */
export class WelcomeBannerComponent implements Component {
  constructor(private readonly getData: () => WelcomeBannerData) {}

  render(width: number): string[] {
    return renderWelcomeBanner(this.getData(), width);
  }

  invalidate(): void {
    // No cache: width and model/session data are both live inputs.
  }
}

export function renderWelcomeBanner(data: WelcomeBannerData, columns: number): string[] {
  const available = Math.max(1, Math.floor(columns));
  if (available < 24) {
    return [
      truncateToWidth(chalk.bold.cyan("Bubble") + chalk.dim(" · /help"), available),
      "",
    ];
  }

  const cardWidth = Math.min(96, available - 2);
  const contentWidth = cardWidth - 6; // border + two-cell horizontal padding
  const margin = " ".repeat(Math.max(0, Math.floor((available - cardWidth) / 2)));
  const border = (value: string) => chalk.cyan(value);
  const row = (content = "") => {
    const fitted = truncateToWidth(content, contentWidth);
    const padded = `${fitted}${" ".repeat(Math.max(0, contentWidth - stringWidth(fitted)))}`;
    return `${margin}${border("│")}  ${padded}  ${border("│")}`;
  };

  const rows: string[] = [
    `${margin}${border(`╭${"─".repeat(Math.max(0, cardWidth - 2))}╮`)}`,
    row(),
  ];

  if (contentWidth >= 34) {
    const title = gradient("Welcome to Bubble!", "#67e8f9", "#a78bfa");
    const subtitle = chalk.dim("I am a cat and you can send /help for help information.");
    const copy = ["", title, subtitle, "", ""];
    for (let index = 0; index < COMPACT_CAT.length; index++) {
      const cat = chalk.bold.hex(interpolateHex("#67e8f9", "#a78bfa", index / (COMPACT_CAT.length - 1)))(COMPACT_CAT[index]!);
      rows.push(row(`${cat}  ${copy[index] ?? ""}`));
    }
  } else {
    rows.push(row(chalk.bold.cyan("Welcome to Bubble!")));
    rows.push(row(chalk.dim("Send /help for help")));
  }

  rows.push(row());
  const labels = ["Directory:", "Session:", "Model:", "Version:"];
  const labelWidth = Math.max(...labels.map((label) => label.length)) + 1;
  const model = formatWelcomeModel(data);
  const info: Array<[string, string]> = [
    ["Directory:", data.cwd],
    ...(data.session ? [["Session:", data.session] as [string, string]] : []),
    ["Model:", model],
    ["Version:", PACKAGE_VERSION],
  ];
  for (const [label, value] of info) {
    rows.push(row(`${chalk.dim(label.padEnd(labelWidth))}${value}`));
  }
  if (data.updateNotice) {
    rows.push(row());
    rows.push(row(chalk.yellow(data.updateNotice)));
  }
  rows.push(row());
  rows.push(`${margin}${border(`╰${"─".repeat(Math.max(0, cardWidth - 2))}╯`)}`);
  rows.push("");
  return rows;
}

export function formatWelcomeModel(data: Pick<WelcomeBannerData, "model" | "provider" | "thinking">): string {
  const model = displayModel(data.model);
  const thinking = data.thinking && data.thinking !== "off" ? data.thinking : undefined;
  const provider = data.provider ?? "";
  const modelParts: string[] = [];
  if (thinking && (isThinkingToggleModel(provider, data.model) || isThinkingOnlyModel(provider, data.model))) {
    modelParts.push(model, "thinking mode");
  } else if (thinking) {
    modelParts.push(`${model} with ${thinking} effort`);
  } else {
    modelParts.push(model);
  }
  if (provider && !provider.toLowerCase().includes("minimax")) modelParts.push(provider);
  return modelParts.join(" · ");
}

function gradient(text: string, from: string, to: string): string {
  const chars = [...text];
  return chars.map((char, index) => {
    const t = chars.length <= 1 ? 0 : index / (chars.length - 1);
    const color = interpolateHex(from, to, t);
    return chalk.bold.hex(color)(char);
  }).join("");
}

function interpolateHex(from: string, to: string, t: number): string {
  const a = [1, 3, 5].map((index) => Number.parseInt(from.slice(index, index + 2), 16));
  const b = [1, 3, 5].map((index) => Number.parseInt(to.slice(index, index + 2), 16));
  const channels = a.map((value, index) => Math.round(value + ((b[index] ?? value) - value) * t));
  return `#${channels.map((value) => value.toString(16).padStart(2, "0")).join("")}`;
}

function readPackageVersion(): string {
  try {
    const pkg = require("../../../package.json") as { version?: string };
    return pkg.version ? `v${pkg.version}` : "v0.0.0";
  } catch {
    return "v0.0.0";
  }
}
