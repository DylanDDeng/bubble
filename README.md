# Bubble

Bubble is a terminal coding agent for working inside local project folders. It can read and edit files, run commands with approval controls, use project skills, connect MCP tools, and keep persistent memory across sessions.

## Requirements

- Bun
- Node.js and npm

Install Bun if it is not already available:

```bash
curl -fsSL https://bun.sh/install | bash
```

## Install

From npm:

```bash
npm install -g bubble
```

From a local package tarball:

```bash
npm install -g ./bubble-0.0.1.tgz
```

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
