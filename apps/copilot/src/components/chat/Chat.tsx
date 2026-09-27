'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { t } from '@/i18n/ar';
import { EmptyState, ErrorState, Skeleton } from '@/components/ui/States';
import { Button } from '@/components/ui/Button';
import { loadConversation, sendMessage, type ChatMessage } from './api';
import { Composer } from './Composer';
import { Message } from './Message';
import { WaitingIndicator } from './WaitingIndicator';

const LOGIN_PATH = '/copilot/login';
// The question the assistant can already answer today (suggest.3) comes
// first, ahead of the two document-intake suggestions that only produce
// `chat.flow_pending` until a later milestone.
const SUGGESTION_KEYS = ['chat.suggest.3', 'chat.suggest.1', 'chat.suggest.2'] as const;

type Phase = 'loading' | 'error' | 'ready';

/**
 * The home page's chat panel: loads the signed-in user's latest conversation
 * on mount, then lets them send more. `userName` is accepted for the page to
 * pass through (spec/madar/03 §3) but this component has nothing of its own
 * to show with it today — the greeting lives on the page, not in here.
 */
export function Chat({ userName: _userName }: { userName?: string } = {}) {
  const [phase, setPhase] = useState<Phase>('loading');
  const [errorMessage, setErrorMessage] = useState('');
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    setPhase('loading');
    const result = await loadConversation();
    if (!result.ok) {
      if (result.kind === 'unauthenticated') {
        window.location.assign(LOGIN_PATH);
        return;
      }
      // `npi_down` (503) carries a real message about NPI specifically, from
      // the server or api.ts's own npi_down-flavoured fallback — worth
      // keeping. Every other kind ('server', 'network') only ever gets a
      // generic client-side fallback text (no message from the server at
      // all), and this screen's own error state is specifically about
      // reaching NPI, so it shows `home.error.npi` instead of that generic
      // text.
      setErrorMessage(result.kind === 'npi_down' ? result.messageAr : t('home.error.npi'));
      setPhase('error');
      return;
    }
    setConversationId(result.conversationId);
    setMessages(result.messages);
    setPhase('ready');
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: 'end' });
  }, [messages, sending]);

  function fillComposer(text: string) {
    setDraft(text);
    textareaRef.current?.focus();
  }

  async function handleSend() {
    const text = draft.trim();
    if (text.length === 0 || sending) return;

    const optimisticUser: ChatMessage = {
      id: `local-${Date.now()}`,
      role: 'user',
      textAr: text,
      badges: [],
      memoryNotes: [],
      createdAt: new Date().toISOString(),
    };
    setMessages((prev) => [...prev, optimisticUser]);
    setDraft('');
    setSending(true);

    const result = await sendMessage(text, conversationId ?? undefined);
    setSending(false);

    if (!result.ok) {
      if (result.kind === 'unauthenticated') {
        window.location.assign(LOGIN_PATH);
        return;
      }
      // Nothing is lost: the error is shown as its own notice bubble, and the
      // text goes back into the composer for the user to retry.
      // The bubble of the message that was not accepted is taken out, so a
      // retry does not show it twice; its text goes back to the composer.
      setMessages((prev) => [
        ...prev.filter((m) => m.id !== optimisticUser.id),
        {
          id: `local-error-${Date.now()}`,
          role: 'assistant',
          textAr: result.messageAr,
          badges: [],
          memoryNotes: [],
          createdAt: new Date().toISOString(),
          kind: 'error',
        },
      ]);
      setDraft(text);
      return;
    }

    setConversationId(result.conversationId);
    setMessages((prev) => [
      ...prev,
      {
        id: result.messageId,
        role: 'assistant',
        textAr: result.textAr,
        badges: result.badges,
        memoryNotes: result.memoryNotes,
        createdAt: new Date().toISOString(),
        kind: result.kind,
      },
    ]);
  }

  if (phase === 'loading') {
    return (
      <div className="flex flex-col gap-3" aria-busy="true">
        <Skeleton className="h-16 w-2/3" />
        <Skeleton className="h-16 w-1/2 self-end" />
        <Skeleton className="h-16 w-3/5" />
      </div>
    );
  }

  if (phase === 'error') {
    return <ErrorState message={errorMessage} onRetry={load} />;
  }

  const isEmpty = messages.length === 0;

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-3">
      <div
        role="log"
        aria-live="polite"
        aria-label={t('nav.chat')}
        className="flex min-h-[16rem] flex-col gap-3"
      >
        {isEmpty ? (
          <EmptyState message={t('home.empty')}>
            <div className="flex flex-wrap justify-center gap-2">
              {SUGGESTION_KEYS.map((key) => (
                <Button key={key} type="button" variant="secondary" size="sm" onClick={() => fillComposer(t(key))}>
                  {t(key)}
                </Button>
              ))}
            </div>
          </EmptyState>
        ) : (
          messages.map((message) => <Message key={message.id} message={message} />)
        )}
        {sending ? <WaitingIndicator /> : null}
        {/* scroll-mb-* is what actually keeps the newest message clear of the
            sticky composer below: Element.scrollIntoView respects
            scroll-margin, so a plain `block: 'end'` lands above the
            composer/tab-bar stack instead of behind it. */}
        <div ref={bottomRef} className="scroll-mb-56" />
      </div>
      {/* Sticky, not fixed: it scrolls with the page until it reaches the
          bottom of the viewport, then holds there — above the fixed mobile
          tab bar (whose real height is the same `--copilot-tabbar-h` this
          reads, see globals.css), flush with the viewport bottom from `md`
          up where AppShell's nav is a static side rail instead. The page
          background here stops messages from showing through, and `z-10`
          keeps it above content scrolling underneath. */}
      <div
        data-testid="composer-wrapper"
        className="sticky bottom-[calc(var(--copilot-tabbar-h)+env(safe-area-inset-bottom))] z-10 bg-[#f4f6f8] pt-2 md:bottom-0"
      >
        <Composer ref={textareaRef} value={draft} onChange={setDraft} onSend={handleSend} disabled={sending} />
      </div>
    </div>
  );
}
