import { BubbleLogo } from './BubbleLogo';

/** Bubble identity in the same landing/loading slot as the reference app. */
export function LogoShimmer({ size = 56, className = '' }: { size?: number; className?: string }) {
  return <div className={`opacity-35 ${className}`} style={{ width: size, height: size }} aria-hidden="true"><BubbleLogo className="h-full w-full" /></div>;
}
