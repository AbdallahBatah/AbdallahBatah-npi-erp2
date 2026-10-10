import { ReactNode } from 'react';

export interface CardProps {
  title?: string;
  /** Draws the gold approval/preview-card edge on the inline-start side. */
  edge?: 'gold';
  className?: string;
  children: ReactNode;
}

export function Card({ title, edge, className = '', children }: CardProps) {
  return (
    <div
      className={[
        'rounded-xl bg-white shadow-card',
        edge === 'gold' ? 'border-s-4 border-gold' : '',
        className,
      ]
        .filter(Boolean)
        .join(' ')}
    >
      {title ? (
        <h3 className="border-b border-slate-100 px-4 py-3 text-lg font-bold text-slate-900">
          {title}
        </h3>
      ) : null}
      <div className="p-4">{children}</div>
    </div>
  );
}
