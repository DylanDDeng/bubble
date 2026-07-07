"""
Harbor agent adapter for Bubble.

Implements the BaseInstalledAgent interface so Bubble can run in
Terminal-Bench (2.x) evaluations via Harbor.

Bubble specifics this adapter has to bridge:
- Bubble reads provider credentials from ~/.bubble/models.json, not from
  environment variables, so the first run command materializes that file
  from the host-side API-key env var.
- Bubble's launcher (bin.js) hard-requires Bun; the install template
  installs Node 22 (for the launcher shebang + npm) and Bun.
- Headless mode is `bubble -p --dangerously-skip-permissions <prompt>`.
"""

import json
import os
import shlex
from pathlib import Path

from harbor.agents.installed.base import BaseInstalledAgent, ExecInput
from harbor.models.agent.context import AgentContext
from harbor.models.trial.paths import EnvironmentPaths

# Harbor passes models as "provider/model" (litellm-style). Map the provider
# segment onto Bubble's builtin provider ids (src/model-catalog.ts).
PROVIDER_ID_MAP = {
    "gemini": "google",
    "moonshot": "moonshot-intl",
    "kimi": "kimi-for-coding",
    "zhipu": "zhipuai",
}

# Host env var that carries the API key for each Bubble provider id.
# Fallback is <PROVIDER>_API_KEY with dashes turned into underscores.
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

# The install script sets up node via nvm and bun under $HOME; run commands
# execute in a fresh shell, so re-source both before invoking bubble.
SHELL_PRELUDE = (
    'export NVM_DIR="$HOME/.nvm"; '
    '[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"; '
    'export PATH="$HOME/.bun/bin:$PATH"; '
)


class BubbleAgent(BaseInstalledAgent):
    """Runs Bubble headlessly inside Terminal-Bench task containers."""

    @staticmethod
    def name() -> str:
        return "bubble"

    @property
    def _install_agent_template_path(self) -> Path:
        return Path(__file__).parent / "install-bubble.sh.j2"

    def _resolve_provider_and_model(self) -> tuple[str, str]:
        if not self.model_name:
            raise ValueError(
                "BubbleAgent needs a model, e.g. -m anthropic/claude-sonnet-4-5"
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
        # BUBBLE_API_KEY wins as an explicit override for exotic setups.
        api_key = os.environ.get("BUBBLE_API_KEY") or os.environ.get(env_var)
        if not api_key:
            raise ValueError(
                f"No API key for provider '{provider}': set {env_var} (or BUBBLE_API_KEY)"
            )
        return api_key

    def create_run_agent_commands(self, instruction: str) -> list[ExecInput]:
        provider, model = self._resolve_provider_and_model()
        api_key = self._resolve_api_key(provider)

        models_json = json.dumps(
            {"providers": {provider: {"apiKey": api_key}}}
        )

        output_dir = EnvironmentPaths.agent_dir
        output_file = output_dir / "bubble-output.txt"

        setup_config = (
            f"mkdir -p $HOME/.bubble {output_dir} && "
            f"printf '%s' {shlex.quote(models_json)} > $HOME/.bubble/models.json"
        )

        run_bubble = (
            SHELL_PRELUDE
            + f"bubble -p --dangerously-skip-permissions -m {shlex.quote(model)} "
            + f"{shlex.quote(instruction)} 2>&1 | tee {output_file}"
        )

        return [
            ExecInput(command=setup_config),
            ExecInput(command=run_bubble),
        ]

    def populate_context_post_run(self, context: AgentContext) -> None:
        # Bubble's -p mode prints plain text and does not emit a structured
        # trajectory yet, so token/cost accounting is left unset. The raw
        # transcript is preserved via `tee` for manual inspection.
        output_file = self.logs_dir / "bubble-output.txt"
        if not output_file.exists():
            print(f"bubble output file not found: {output_file}")
