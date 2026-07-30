"""
Harbor agent adapter for Bubble.

Rewritten for Harbor's current BaseInstalledAgent API (the original was
written against a 2026-07 draft whose install-template hook no longer
exists): install() and run() are overridden directly, mirroring the
in-tree claude_code adapter.

Bubble specifics this adapter bridges:
- Provider credentials come from ~/.bubble/models.json inside the
  container, materialized from the host-side API-key env var.
- Bubble's launcher (bin.js) hard-requires Bun; install() sets up Node 22
  (nvm) + Bun.
- `tarball=<host path>` agent-kwarg installs a local `npm pack` tarball
  instead of the npm registry — required to benchmark unpublished HEADs.
- `bubble -p --output-format json` emits a final JSON object with usage,
  which run() parses into AgentContext token accounting.
"""

import json
import os
import shlex
import uuid
from pathlib import Path

from harbor.agents.installed.base import BaseInstalledAgent
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext

# Harbor passes models as "provider/model" (litellm-style). Map the provider
# segment onto Bubble's builtin provider ids (src/model-catalog.ts).
PROVIDER_ID_MAP = {
    "gemini": "google",
    "moonshot": "moonshot-intl",
    "kimi": "kimi-for-coding",
    "zhipu": "zhipuai",
}

API_KEY_ENV_MAP = {
    "anthropic": "ANTHROPIC_API_KEY",
    "openai": "OPENAI_API_KEY",
    "google": "GEMINI_API_KEY",
    "deepseek": "DEEPSEEK_API_KEY",
    "moonshot-intl": "MOONSHOT_API_KEY",
    "kimi-for-coding": "KIMI_API_KEY",
    "zhipuai": "ZHIPUAI_API_KEY",
    "openrouter": "OPENROUTER_API_KEY",
}

# install() sets up node via nvm and bun under $HOME; run() executes in a
# fresh shell, so re-source both before invoking bubble.
SHELL_PRELUDE = (
    'export NVM_DIR="$HOME/.nvm"; '
    '[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"; '
    'export PATH="$HOME/.bun/bin:$PATH"; '
)

CONTAINER_TARBALL = "/tmp/bubble-local.tgz"


class BubbleAgent(BaseInstalledAgent):
    """Runs Bubble headlessly inside Terminal-Bench task containers."""

    def __init__(self, *args, tarball: str | None = None, **kwargs):
        super().__init__(*args, **kwargs)
        self._tarball = tarball

    @staticmethod
    def name() -> str:
        return "bubble"

    # ------------------------------------------------------------------ setup

    async def install(self, environment: BaseEnvironment) -> None:
        await self.exec_as_root(
            environment,
            command=(
                "apt-get update && apt-get install -y curl unzip ca-certificates"
            ),
            timeout_sec=600,
        )
        # Node 22 via nvm (launcher shebang + npm) and Bun (bin.js re-exec).
        await self.exec_as_agent(
            environment,
            command=(
                "curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.2/install.sh | bash && "
                'export NVM_DIR="$HOME/.nvm" && . "$NVM_DIR/nvm.sh" && '
                "nvm install 22 && node -v && "
                "curl -fsSL https://bun.sh/install | bash && "
                '"$HOME/.bun/bin/bun" --version'
            ),
            timeout_sec=900,
        )

        if self._tarball:
            tarball_path = Path(self._tarball).expanduser().resolve()
            if not tarball_path.exists():
                raise RuntimeError(f"local bubble tarball not found: {tarball_path}")
            await environment.upload_file(str(tarball_path), CONTAINER_TARBALL)
            # upload_file lands root-owned; npm -g under nvm runs as agent.
            await self.exec_as_root(
                environment, command=f"chmod 644 {CONTAINER_TARBALL}"
            )
            install_spec = CONTAINER_TARBALL
        else:
            version = self.version or "latest"
            install_spec = f"@bubblebrain-ai/bubble@{version}"

        await self.exec_as_agent(
            environment,
            command=SHELL_PRELUDE + f"npm install -g {shlex.quote(install_spec)} && bubble -v",
            timeout_sec=600,
        )

    # ------------------------------------------------------------------- run

    def _resolve_provider_and_model(self) -> tuple[str, str]:
        if not self.model_name:
            raise ValueError(
                "BubbleAgent needs a model, e.g. -m deepseek/deepseek-v4-pro"
            )
        if "/" in self.model_name:
            provider, model = self.model_name.split("/", 1)
        else:
            provider, model = "anthropic", self.model_name
        provider = PROVIDER_ID_MAP.get(provider, provider)
        return provider, model

    def _resolve_api_key(self, provider: str) -> str:
        env_var = API_KEY_ENV_MAP.get(
            provider, provider.upper().replace("-", "_") + "_API_KEY"
        )
        api_key = os.environ.get("BUBBLE_API_KEY") or os.environ.get(env_var)
        if not api_key:
            raise ValueError(
                f"No API key for provider '{provider}': set {env_var} (or BUBBLE_API_KEY)"
            )
        return api_key

    async def run(
        self, instruction: str, environment: BaseEnvironment, context: AgentContext
    ) -> None:
        provider, model = self._resolve_provider_and_model()
        api_key = self._resolve_api_key(provider)

        models_json = json.dumps({"providers": {provider: {"apiKey": api_key}}})
        await self.exec_as_agent(
            environment,
            command=(
                "mkdir -p $HOME/.bubble /logs/agent && "
                f"printf '%s' {shlex.quote(models_json)} > $HOME/.bubble/models.json"
            ),
        )

        # Instruction travels via env var (claude_code pattern): no shell
        # quoting hazards, and it never appears in `ps` output.
        shell_var = f"harbor_bubble_instruction_{uuid.uuid4().hex}"
        env_var = shell_var.upper()

        await self.exec_as_agent(
            environment,
            command=(
                SHELL_PRELUDE
                + f'{shell_var}="${env_var}"; unset {env_var}; '
                + "bubble -p --dangerously-skip-permissions --output-format json "
                + f'-m {shlex.quote(model)} "${shell_var}" '
                + "2>&1 | tee /logs/agent/bubble-output.txt"
            ),
            env={env_var: instruction},
        )

        self._populate_context(context)

    def _populate_context(self, context: AgentContext) -> None:
        """Parse the final JSON line of bubble's -p output into token counts."""
        output_file = self.logs_dir / "bubble-output.txt"
        if not output_file.exists():
            self.logger.warning(f"bubble output file not found: {output_file}")
            return
        try:
            lines = output_file.read_text(errors="replace").strip().splitlines()
            payload = None
            for line in reversed(lines):
                line = line.strip()
                if line.startswith("{") and line.endswith("}"):
                    payload = json.loads(line)
                    break
            if not payload:
                return
            usage = payload.get("usage") or {}
            context.n_input_tokens = usage.get("input_tokens")
            context.n_cache_tokens = usage.get("cache_read_input_tokens")
            context.n_output_tokens = usage.get("output_tokens")
        except Exception as exc:  # accounting is best-effort, never fail a trial
            self.logger.warning(f"failed to parse bubble output json: {exc}")
