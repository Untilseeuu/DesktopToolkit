import type { ButtonHTMLAttributes, ReactNode } from "react";
import { AppWindow, Check, ChevronRight, File, Folder, Link2 } from "lucide-react";
import type { SearchResult } from "./types";

export function ResultGlyph({
  result,
  size = 19,
}: {
  result: SearchResult;
  size?: number;
}) {
  if (result.kind === "app" && result.iconDataUrl) {
    return (
      <img
        className="result-app-image"
        src={result.iconDataUrl}
        alt={result.name}
        width={size}
        height={size}
      />
    );
  }
  const Icon = result.kind === "link"
    ? Link2
    : result.kind === "app"
      ? AppWindow
      : result.kind === "folder"
        ? Folder
        : File;
  return <Icon size={size} />;
}

export function Switch({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
}) {
  return (
    <button
      type="button"
      className={`switch ${checked ? "is-on" : ""}`}
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={(event) => {
        event.stopPropagation();
        onChange(!checked);
      }}
    >
      <span className="switch-knob">
        {checked ? <Check size={11} strokeWidth={3} /> : null}
      </span>
    </button>
  );
}

export function ToolBadge({
  enabled,
  children,
}: {
  enabled: boolean;
  children: ReactNode;
}) {
  return (
    <span className={`status-badge ${enabled ? "active" : ""}`}>
      <i />
      {children}
    </span>
  );
}

export function SectionHeading({
  eyebrow,
  title,
  description,
  action,
}: {
  eyebrow: string;
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <header className="section-heading">
      <div>
        <span className="eyebrow">{eyebrow}</span>
        <h1>{title}</h1>
        <p>{description}</p>
      </div>
      {action ? <div className="heading-action">{action}</div> : null}
    </header>
  );
}

export function EmptyState({
  icon,
  title,
  description,
  action,
}: {
  icon: ReactNode;
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <div className="empty-state">
      <div className="empty-icon">{icon}</div>
      <h3>{title}</h3>
      <p>{description}</p>
      {action}
    </div>
  );
}

export function ArrowButton({
  children,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button type="button" className="text-action" {...props}>
      {children}
      <ChevronRight size={15} />
    </button>
  );
}
