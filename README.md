# Bubble

Bubble is a terminal coding agent for working inside local project folders. It can read and edit files, run commands with approval controls, use project skills, connect MCP tools, and keep persistent memory across sessions.

## Requirements

- Node.js 20+ and npm for installation
- Bun for running Bubble

Install Bun if it is not already available:

```bash
curl -fsSL https://bun.sh/install | bash
```

## Install

From npm:

```bash
npm install -g @bubblebrain-ai/bubble
```

From a local package tarball:

```bash
npm install -g ./bubblebrain-ai-bubble-0.0.3.tgz
```

The npm command installs a small Node.js launcher named `bubble`. When you run
`bubble`, the launcher checks for Bun and starts the real Bubble runtime with
`bun`. If Bun is missing, it prints the install command above instead of failing
with a low-level runtime error.

## Usage

Start Bubble in the current directory:

```bash
bubble
```

Start Bubble for a specific project:

```bash
bubble --cwd /path/to/project
```

Show CLI options:

```bash
bubble --help
```

## Configuration

Bubble stores user configuration, sessions, permissions, skills, and memory under:

```text
~/.bubble
```

In the app, use `/login` or provider commands to configure model access.

## Memory

Bubble maintains persistent memory automatically from prior sessions. Useful commands:

```text
/memory status
/memory search <query>
/memory refresh
```

Memory is maintained by a background pipeline and can be refreshed manually when you want new session information to be indexed immediately.
