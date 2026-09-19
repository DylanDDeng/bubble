import { OpenCodeLogo } from '../OpenCodeLogo';
import claudeLogo from '../../assets/claude-color.svg';
import openaiLogo from '../../assets/openai.svg';
import moonshotLogo from '../../assets/moonshot.svg';
import grokLogo from '../../assets/grok.svg';
import deepseekLogo from '../../assets/deepseek-color.svg';
import minimaxLogo from '../../assets/minimax-color.svg';
import zhipuLogo from '../../assets/zhipu-color.svg';
import alibabaLogo from '../../assets/alibaba-color.svg';
import bailianLogo from '../../assets/bailian-color.svg';
import fireworksLogo from '../../assets/fireworks-color.svg';
import geminiLogo from '../../assets/gemini-color.svg';
import volcengineLogo from '../../assets/volcengine-color.svg';
import stepfunLogo from '../../assets/stepfun.svg';
import openrouterLogo from '../../assets/openrouter-color.svg';

// Brand artwork already bundled for other pickers, keyed by Bubble provider id.
// Providers without artwork fall back to a monogram tile in ProviderLogo.
const PROVIDER_LOGOS: Record<string, string> = {
  anthropic: claudeLogo,
  openai: openaiLogo,
  openrouter: openrouterLogo,
  'openai-codex': openaiLogo,
  grok: grokLogo,
  deepseek: deepseekLogo,
  minimax: minimaxLogo,
  'minimax-anthropic': minimaxLogo,
  zhipuai: zhipuLogo,
  'zhipuai-coding-plan': zhipuLogo,
  zai: zhipuLogo,
  'zai-coding-plan': zhipuLogo,
  alibaba: alibabaLogo,
  'bailian-token-plan': bailianLogo,
  fireworks: fireworksLogo,
  google: geminiLogo,
  doubao: volcengineLogo,
  stepfun: stepfunLogo,
  'moonshot-cn': moonshotLogo,
  'moonshot-intl': moonshotLogo,
  'kimi-for-coding': moonshotLogo,
};

export function ProviderLogo({ providerId, name }: { providerId: string; name: string }) {
  // OpenCode's mark is theme-dependent, so it comes from the shared component
  // rather than the static map.
  if (providerId === 'opencode-zen') return <OpenCodeLogo />;
  const logo = PROVIDER_LOGOS[providerId];
  if (logo) {
    return <img src={logo} alt="" className={`h-4 w-4 flex-shrink-0 ${[claudeLogo, openaiLogo, grokLogo, moonshotLogo, stepfunLogo].includes(logo) ? 'provider-monochrome-logo' : ''}`} aria-hidden="true" />;
  }
  return (
    <span
      aria-hidden="true"
      className="flex h-4 w-4 flex-shrink-0 items-center justify-center rounded bg-[var(--bg-tertiary)] text-[9px] font-semibold uppercase text-[var(--text-muted)]"
    >
      {name.charAt(0)}
    </span>
  );
}

