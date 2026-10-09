'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { t } from '@/i18n/ar';
import { EmptyState, ErrorState, Skeleton } from '@/components/ui/States';
import { Button } from '@/components/ui/Button';
import { ConsentCard } from '@/components/ConsentCard';
import { loadIntake } from '@/components/intake/api';
import type { FlowType, IntakeView } from '@/intake/types';
import {
  consentNeeded,
  loadConversation,
  recordConsent,
  sendMessage,
  uploadDocument,
  type ChatMessage,
  type ConsentDecision,
  type DocumentSummary,
} from './api';
import { Composer } from './Composer';
import { Message } from './Message';
import { WaitingIndicator } from './WaitingIndicator';

const LOGIN_PATH = '/copilot/login';
// The question the assistant can answer without a document (suggest.3) comes
// first, ahead of the two document-intake suggestions.
const SUGGESTION_KEYS = ['chat.suggest.3', 'chat.suggest.1', 'chat.suggest.2'] as const;

type Phase = 'loading' | 'error' | 'ready';

/**
 * The home page's chat panel: loads the signed-in user's latest conversation
 * on mount, then lets them send more. `userName` is accepted for the page to
 * pass through (spec/madar/03 §3) but this component has nothing of its own
 * to show with it today — the greeting lives on the page, not in here.
 *
 * T-22 adds the attach + consent flow on top of that: attaching a file
 * uploads it, shows it as a user bubble, and then either asks for consent
 * (image / scanned PDF) via `ConsentCard` or announces the document is text
 * and ready. T-26 closes the loop: once the document is readable (text
 * straight away, an image after the consent is recorded) the chat sends it
 * to the server, which reads it and answers with an intake job whose
 * `PreviewCard` renders under the reply (`Message`). When the server cannot
 * tell what the document is, the reply carries five flow chips; picking one
 * sends the same document again with `forcedFlow`.
 */
export function Chat({ userName: _userName }: { userName?: string } = {}) {
  const [phase, setPhase] = useState<Phase>('loading');
  const [errorMessage, setErrorMessage] = useState('');
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  // The intake jobs of the loaded history, read before the thread renders so
  // every card appears at its final height with the messages (T-39: each
  // card's skeleton → card swap after the scroll to the bottom was a layout
  // shift of ~0.9 on this screen). A card whose read failed is simply absent
  // here and loads itself as before.
  const [intakeViews, setIntakeViews] = useState<ReadonlyMap<string, IntakeView>>(new Map());
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [attaching, setAttaching] = useState(false);
  const [pendingConsent, setPendingConsent] = useState<{ document: DocumentSummary } | null>(null);
  const [consentBusy, setConsentBusy] = useState(false);
  const [consentError, setConsentError] = useState<string | null>(null);
  // The label of the intake read in flight (the server reads synchronously
  // inside the chat turn), or null.
  const [intakeBusy, setIntakeBusy] = useState<string | null>(null);
  // Page count of each document uploaded in this session, for the «page n of
  // m» label when a chip re-sends it.
  const documentPages = useRef(new Map<string, number>());

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  // `submitIntake` closes over state and is a new function every render; the
  // memoised `Message` needs one stable callback, so the chips call through
  // this ref (T-39).
  const submitIntakeRef = useRef<(input: { documentId: string; forcedFlow: FlowType }) => void>(() => {});
  const handleChooseFlow = useCallback((flow: FlowType, documentId: string) => {
    submitIntakeRef.current({ documentId, forcedFlow: flow });
  }, []);

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
    const jobIds = [...new Set(result.messages.flatMap((m) => (m.intakeJobId ? [m.intakeJobId] : [])))];
    const views = new Map<string, IntakeView>();
    await Promise.all(
      jobIds.map(async (id) => {
        const job = await loadIntake(id);
        if (job.ok) views.set(id, job.job);
      }),
    );
    setIntakeViews(views);
    setConversationId(result.conversationId);
    setMessages(result.messages);
    setPhase('ready');
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: 'end' });
  }, [messages, sending, attaching, pendingConsent, intakeBusy]);

  // Keep the ref on the latest `submitIntake` (a hoisted function declaration below).
  useEffect(() => {
    submitIntakeRef.current = submitIntake;
  });

  function fillComposer(text: string) {
    setDraft(text);
    textareaRef.current?.focus();
  }

  function appendNotice(textAr: string, kind: ChatMessage['kind'] = 'answer') {
    setMessages((prev) => [
      ...prev,
      {
        id: `local-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        role: 'assistant',
        textAr,
        badges: [],
        memoryNotes: [],
        createdAt: new Date().toISOString(),
        kind,
      },
    ]);
  }

  async function handleAttach(file: File) {
    if (attaching || pendingConsent) return;
    setAttaching(true);
    const result = await uploadDocument(file);
    setAttaching(false);

    if (!result.ok) {
      if (result.kind === 'unauthenticated') {
        window.location.assign(LOGIN_PATH);
        return;
      }
      appendNotice(result.messageAr, 'error');
      return;
    }

    const { document, deduplicated } = result;
    documentPages.current.set(document.id, document.pageCount);
    setMessages((prev) => [
      ...prev,
      {
        id: `local-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        role: 'user',
        textAr: t('chat.attached', { name: document.fileName }),
        badges: [],
        memoryNotes: [],
        createdAt: new Date().toISOString(),
      },
    ]);

    if (deduplicated) appendNotice(t('chat.document_duplicate'));

    if (consentNeeded(document.kind)) {
      setConsentError(null);
      setPendingConsent({ document });
    } else {
      appendNotice(t('chat.document_text_ready'));
      submitIntake({ documentId: document.id, text: takeDraft() });
    }
  }

  /** The typed sentence that goes with an attachment; the composer is
   *  cleared because the sentence now travels with the document. */
  function takeDraft(): string | undefined {
    const text = draft.trim();
    if (text.length === 0) return undefined;
    setDraft('');
    return text;
  }

  /** Sends a document (optionally with the flow the user picked) to the
   *  server, which reads it inside this one request and answers with the
   *  intake job (or a failure/choice reply). */
  async function submitIntake(input: { documentId: string; text?: string; forcedFlow?: FlowType }) {
    if (intakeBusy !== null) return;
    const pages = documentPages.current.get(input.documentId);
    setIntakeBusy(
      pages === undefined ? t('intake.reading_text') : t('intake.reading', { n: 1, total: pages }),
    );
    const result = await sendMessage({ ...input, conversationId: conversationId ?? undefined });
    setIntakeBusy(null);

    if (!result.ok) {
      if (result.kind === 'unauthenticated') {
        window.location.assign(LOGIN_PATH);
        return;
      }
      appendNotice(result.messageAr, 'error');
      if (input.text) setDraft(input.text);
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
        ...(result.intakeJobId !== undefined ? { intakeJobId: result.intakeJobId } : {}),
        ...(result.documentId !== undefined ? { documentId: result.documentId } : {}),
      },
    ]);
  }

  async function handleConsent(decision: ConsentDecision) {
    if (!pendingConsent || consentBusy) return;
    setConsentBusy(true);
    const result = await recordConsent(pendingConsent.document.id, decision);
    setConsentBusy(false);

    if (!result.ok) {
      if (result.kind === 'unauthenticated') {
        window.location.assign(LOGIN_PATH);
        return;
      }
      // The card stays up — nothing is lost, the user can retry the same
      // decision (or pick the other one).
      setConsentError(result.messageAr || t('consent.error'));
      return;
    }

    setPendingConsent(null);
    setConsentError(null);
    appendNotice(t(decision === 'approved' ? 'chat.consent_recorded' : 'chat.consent_cancelled'));
    if (decision === 'approved') submitIntake({ documentId: pendingConsent.document.id, text: takeDraft() });
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

    const result = await sendMessage({ text, conversationId: conversationId ?? undefined });
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
        ...(result.intakeJobId !== undefined ? { intakeJobId: result.intakeJobId } : {}),
        ...(result.documentId !== undefined ? { documentId: result.documentId } : {}),
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
          messages.map((message) => (
            <Message
              key={message.id}
              message={message}
              intakeView={message.intakeJobId ? intakeViews.get(message.intakeJobId) : undefined}
              chipsDisabled={sending || intakeBusy !== null}
              onChooseFlow={handleChooseFlow}
            />
          ))
        )}
        {attaching ? <WaitingIndicator label={t('chat.attaching')} /> : null}
        {pendingConsent ? (
          <ConsentCard
            document={pendingConsent.document}
            policyLine={t('consent.policy_line')}
            busy={consentBusy}
            errorMessage={consentError}
            onApprove={() => handleConsent('approved')}
            onCancel={() => handleConsent('cancelled')}
          />
        ) : null}
        {sending ? <WaitingIndicator /> : null}
        {intakeBusy !== null ? <WaitingIndicator label={intakeBusy} /> : null}
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
        <Composer
          ref={textareaRef}
          value={draft}
          onChange={setDraft}
          onSend={handleSend}
          onAttach={handleAttach}
          disabled={sending || intakeBusy !== null}
          attachDisabled={attaching || pendingConsent !== null}
        />
      </div>
    </div>
  );
}
