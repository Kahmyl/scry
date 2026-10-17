import type { ReactNode } from "react";

export function PageTitle({
  eyebrow,
  title,
  copy,
  action,
}: {
  eyebrow: string;
  title: string;
  copy: string;
  action?: ReactNode;
}) {
  return (
    <div className="page-title">
      <div>
        <div className="eyebrow lime">{eyebrow}</div>
        <h1>{title}</h1>
        <p>{copy}</p>
      </div>
      {action}
    </div>
  );
}

export function EmptyBlock({
  icon,
  title,
  copy,
}: {
  icon: ReactNode;
  title: string;
  copy: string;
}) {
  return (
    <div className="empty-block">
      <div>{icon}</div>
      <strong>{title}</strong>
      <span>{copy}</span>
    </div>
  );
}

export function PageSkeleton() {
  return (
    <div className="skeleton-page">
      <div />
      <div />
      <div className="skeleton-grid">
        <span />
        <span />
        <span />
      </div>
      <div className="skeleton-panel" />
    </div>
  );
}
