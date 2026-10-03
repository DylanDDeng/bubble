import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { MessageCircle, Minus, ExpandDiagonal } from './icons';
import { useBrowserNativeOverlayRegistration } from './browser/browser-native-overlay';

/** One mounted conversation moves between split, full-page and floating layouts. */
export function FullViewChatRegion({ fullView, chatSelected = false, title = 'Chat', sessionId, onSelectChat, onHeightChange, children }: {
  fullView: boolean;
  chatSelected?: boolean;
  title?: string;
  sessionId?: string | null;
  onSelectChat?: () => void;
  onHeightChange: (height: number) => void;
  children: ReactNode;
}) {
  const [expanded, setExpanded] = useState(false);
  const launcher = useRef<HTMLButtonElement>(null);
  const floating = fullView && !chatSelected;
  useEffect(() => { setExpanded(false); }, [fullView, chatSelected, sessionId]);
  useBrowserNativeOverlayRegistration(floating && expanded);
  // Reserve only the small launcher strip for native browser content. An open
  // floating conversation uses the normal native-overlay registration above.
  useLayoutEffect(() => { onHeightChange(floating ? 52 : 0); }, [floating, onHeightChange]);
  const minimize = () => { setExpanded(false); requestAnimationFrame(() => launcher.current?.focus()); };
  useEffect(() => {
    if (!floating || !expanded) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented || document.querySelector('[role="dialog"], [role="menu"], [role="alertdialog"]')) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      minimize();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [floating, expanded]);
  return <>
    <div data-full-view-chat={fullView} data-floating-chat={floating || undefined} data-chat-expanded={floating && expanded || undefined}
      inert={floating && !expanded} aria-hidden={floating && !expanded}
      className={floating ? `bubble-full-view-chat ${expanded ? 'is-expanded' : 'is-collapsed'}` : 'contents'}>
      {floating && <div className="bubble-floating-chat-header">
        <button type="button" aria-label="Minimize chat" className="bubble-header-button" onClick={minimize}><Minus className="h-4 w-4" /></button>
        <button type="button" className="bubble-floating-chat-title" onClick={onSelectChat} title="Show full conversation">{title}</button>
        <button type="button" aria-label="Show full conversation" className="bubble-header-button" onClick={onSelectChat}><ExpandDiagonal className="h-3.5 w-3.5" /></button>
      </div>}
      {children}
    </div>
    {floating && !expanded && <button data-floating-chat-launcher ref={launcher} type="button" className="bubble-floating-chat-launcher" aria-label="Open floating chat" onClick={() => setExpanded(true)}><MessageCircle className="h-4 w-4" /></button>}
  </>;
}
