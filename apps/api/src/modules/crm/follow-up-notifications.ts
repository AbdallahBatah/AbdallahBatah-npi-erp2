import { daysOverdue, riyadhDateKey } from '@npi/shared';

/** What a notification about a task needs to say. */
export interface TaskNoticeSource {
  id: string;
  organizationId: string;
  code: string;
  title: string;
  dueAt: Date;
}

export interface CustomerNames {
  nameAr: string;
  nameEn: string;
}

/** The bilingual text of one notification; the caller adds the organization and the recipient. */
interface Notice {
  type: 'TASK_ASSIGNED' | 'TASK_REMINDER' | 'TASK_OVERDUE';
  titleAr: string;
  titleEn: string;
  bodyAr: string;
  bodyEn: string;
  linkPath: string;
}

const link = (task: TaskNoticeSource) => `/tasks?focus=${task.id}`;
const due = (task: TaskNoticeSource) => riyadhDateKey(task.dueAt);

/** Told to the person a task was given to, when somebody else gave it. */
export function taskAssigned(task: TaskNoticeSource, customer: CustomerNames): Notice {
  return {
    type: 'TASK_ASSIGNED',
    titleAr: `كُلِّفت بمهمة متابعة: ${task.title}`,
    titleEn: `You were assigned a follow-up task: ${task.title}`,
    bodyAr: `${task.code} · ${customer.nameAr} · الاستحقاق ${due(task)}`,
    bodyEn: `${task.code} · ${customer.nameEn} · due ${due(task)}`,
    linkPath: link(task),
  };
}

/** The reminder, sent once when it falls due (or at once, for a task created too late for it). */
export function taskReminder(task: TaskNoticeSource, customer: CustomerNames): Notice {
  return {
    type: 'TASK_REMINDER',
    titleAr: `تذكير بمهمة متابعة: ${task.title}`,
    titleEn: `Follow-up task reminder: ${task.title}`,
    bodyAr: `${task.code} · ${customer.nameAr} · الاستحقاق ${due(task)}`,
    bodyEn: `${task.code} · ${customer.nameEn} · due ${due(task)}`,
    linkPath: link(task),
  };
}

/** Sent once, the first time the sweep finds the due day over and the task still open. */
export function taskOverdue(task: TaskNoticeSource, customer: CustomerNames, now: Date): Notice {
  const days = Math.max(1, daysOverdue(task.dueAt, now));
  return {
    type: 'TASK_OVERDUE',
    titleAr: `مهمة متابعة متأخرة: ${task.title}`,
    titleEn: `Follow-up task overdue: ${task.title}`,
    bodyAr: `${task.code} · ${customer.nameAr} · كان الاستحقاق ${due(task)} (متأخرة ${days} ${days === 1 ? 'يوم' : days === 2 ? 'يومين' : days <= 10 ? 'أيام' : 'يوماً'})`,
    bodyEn: `${task.code} · ${customer.nameEn} · was due ${due(task)} (${days} day${days === 1 ? '' : 's'} late)`,
    linkPath: link(task),
  };
}
