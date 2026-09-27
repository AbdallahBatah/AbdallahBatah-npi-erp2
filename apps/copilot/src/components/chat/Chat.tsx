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
const SUGGESTION_KEYS = ['chat.suggest.1', 'chat.suggest.2', 'chat.suggest.3'] as const;

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
      setErrorMessage(result.messageAr || t('home.error.npi'));
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
      setMessages((prev) => [
        ...prev,
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
    <div className="flex flex-col gap-3">
      <div
        role="log"
        aria-live="polite"
        aria-label={t('nav.chat')}
        className="flex min-h-[16rem] flex-col gap-3 overflow-y-auto"
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
        <div ref={bottomRef} />
      </div>
      <Composer ref={textareaRef} value={draft} onChange={setDraft} onSend={handleSend} disabled={sending} />
    </div>
  );
}
