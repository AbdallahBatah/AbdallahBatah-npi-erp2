'use client';

import { useRef, useState } from 'react';
import { t } from '@/i18n/ar';
import { formatDate, formatNumber } from '@/i18n/format';
import { Button } from '@/components/ui/Button';
import type { PredecessorConversation } from '@/positions/handover-types';
import { loadPredecessorConversation, type TranscriptMessage } from './api';

export interface PredecessorChatsProps {
  conversations: PredecessorConversation[];
}

type Transcript =
  | { status: 'loading' }
  | { status: 'ready'; messages: TranscriptMessage[] }
  | { status: 'error'; messageAr: string };

/**
 * The administrator's view of the predecessor's conversations in this
 * position (BR-07). Read-only: each one opens as a plain transcript through
 * the existing `GET /copilot/api/chat?conversationId=`, which answers 200 to
 * an administrator of the organization for a predecessor's conversation and
 * 404 otherwise. Bubbles follow `chat/Message.tsx` (assistant at the inline
 * start, the user's own at the inline end in a brand tint); `Message` itself
 * is not reused because it carries the intake chips. No `dir="auto"` — a
 * message that starts with a document code must still read right-to-left.
 */
export function PredecessorChats({ conversations }: PredecessorChatsProps) {
  const [open, setOpen] = useState<Record<string, Transcript | undefined>>({});
  // Latest load per conversation wins; closing a row also invalidates an
  // in-flight read so a late answer cannot reopen it.
  const seq = useRef<Record<string, number>>({});

  async function openConversation(id: string) {
    const mine = (seq.current[id] = (seq.current[id] ?? 0) + 1);
    setOpen((prev) => ({ ...prev, [id]: { status: 'loading' } }));
    const result = await loadPredecessorConversation(id);
    if (seq.current[id] !== mine) return;
    if (result.ok) {
      setOpen((prev) => ({ ...prev, [id]: { status: 'ready', messages: result.messages } }));
      return;
    }
    if (result.kind === 'unauthenticated') {
      window.location.assign('/copilot/login');
      return;
    }
    const messageAr = result.kind === 'not_found' ? t('handover.chats.not_found') : result.messageAr;
    setOpen((prev) => ({ ...prev, [id]: { status: 'error', messageAr } }));
  }

  function closeConversation(id: string) {
    seq.current[id] = (seq.current[id] ?? 0) + 1;
    setOpen((prev) => ({ ...prev, [id]: undefined }));
  }

  return (
    <div className="flex flex-col gap-3">
      <p className="text-xs text-slate-500">{t('handover.chats.hint')}</p>
      {conversations.length === 0 ? (
        <p className="text-sm text-slate-500">{t('handover.chats.empty')}</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {conversations.map((conversation) => {
            const transcript = open[conversation.id];
            return (
              <li
                key={conversation.id}
                data-testid="handover-chat"
                className="flex flex-col gap-2 rounded-lg border border-slate-200 p-3"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-sm font-semibold text-slate-900">
                    {t('handover.chats.item', {
                      title: conversation.titleAr ?? t('handover.chats.untitled'),
                      date: formatDate(conversation.updatedAt),
                      count: formatNumber(conversation.messageCount),
                    })}
                  </p>
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    onClick={() => (transcript ? closeConversation(conversation.id) : openConversation(conversation.id))}
                    aria-expanded={transcript !== undefined}
                  >
                    {transcript ? t('handover.chats.close') : t('handover.chats.open')}
                  </Button>
                </div>
                {transcript?.status === 'loading' ? (
                  <p role="status" className="text-sm text-slate-500">
                    {t('handover.chats.loading')}
                  </p>
                ) : null}
                {transcript?.status === 'error' ? (
                  <p role="alert" className="text-sm text-danger-700">
                    {transcript.messageAr}
                  </p>
                ) : null}
                {transcript?.status === 'ready' ? (
                  <div data-testid="handover-chat-transcript" className="flex flex-col gap-2">
                    {transcript.messages.map((message) => {
                      const isUser = message.role === 'user';
                      return (
                        <div key={message.id} className={`flex ${isUser ? 'justify-end' : 'justify-start'}`}>
                          <div
                            className={`max-w-[85%] rounded-2xl px-3.5 py-2.5 text-sm sm:max-w-[70%] ${
                              isUser
                                ? 'border border-brand-200 bg-brand-50 text-slate-900'
                                : 'border border-slate-200 bg-white text-slate-900'
                            }`}
                          >
                            <p className="whitespace-pre-wrap break-words leading-6">{message.textAr}</p>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
