import { BubbleSkillLibraryContent } from './BubbleSkillLibrary';

/** A standalone Bubble skill library, with no runtime switcher. */
export function SkillMarketSettingsContent() {
  return <div className="h-full min-h-0 overflow-y-auto px-8 py-7"><div className="mx-auto max-w-[960px]"><BubbleSkillLibraryContent /></div></div>;
}
