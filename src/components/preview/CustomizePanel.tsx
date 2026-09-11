"use client";

import { useState } from "react";

/**
 * Dev-mode color customizer for the standalone /preview route.
 *
 * Patches `blueprint.company.brand.tokens.colors` directly through
 * `/api/projects/[projectId]/theme` — the same non-agent path
 * `sections/route.ts` uses for "add section" — so trying out a color costs no
 * assistant turn and no API token. Every field is optional: a blank input
 * leaves that color untouched rather than clearing it.
 */

export interface ThemeColors {
  primary?: string;
  secondary?: string;
  accent?: string;
  background?: string;
  surface?: string;
  text?: string;
  muted?: string;
  border?: string;
}

const FIELDS: { key: keyof ThemeColors; label: string }[] = [
  { key: "primary", label: "Primary" },
  { key: "secondary", label: "Secondary" },
  { key: "accent", label: "Accent" },
  { key: "background", label: "Background" },
  { key: "surface", label: "Surface" },
  { key: "text", label: "Text" },
  { key: "muted", label: "Muted" },
  { key: "border", label: "Border" },
];

export interface CustomizePanelProps {
  projectId: string;
  initialColors: ThemeColors;
  open: boolean;
  onClose: () => void;
  /** Called after a successful save so the caller can bump the preview's reloadKey. */
  onApplied: () => void;
}

export function CustomizePanel({ projectId, initialColors, open, onClose, onApplied }: CustomizePanelProps) {
  const [colors, setColors] = useState<ThemeColors>(initialColors);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  if (!open) return null;

  const setColor = (key: keyof ThemeColors, value: string) =>
    setColors((prev) => ({ ...prev, [key]: value }));

  const apply = async () => {
    setSaving(true);
    setError("");
    try {
      // Only send colors the operator actually touched, so an empty picker
      // never overwrites a token no one meant to change.
      const submitted = Object.fromEntries(
        Object.entries(colors).filter(([, value]) => typeof value === "string" && value.length > 0),
      );
      const response = await fetch(`/api/projects/${projectId}/theme`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tokens: { colors: submitted } }),
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error ?? `Request failed (${response.status})`);
      }
      onApplied();
      onClose();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not save the theme");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="customize-overlay" role="dialog" aria-modal="true" aria-label="Customize theme">
      <div className="customize-panel">
        <div className="customize-header">
          <h2>Customize</h2>
          <button type="button" className="customize-close" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>

        <div className="customize-fields">
          {FIELDS.map(({ key, label }) => (
            <label key={key} className="customize-field">
              <span>{label}</span>
              <div className="customize-color-row">
                <input
                  type="color"
                  value={colors[key] ?? "#ffffff"}
                  onChange={(event) => setColor(key, event.target.value)}
                />
                <input
                  type="text"
                  value={colors[key] ?? ""}
                  placeholder="unset"
                  onChange={(event) => setColor(key, event.target.value)}
                />
              </div>
            </label>
          ))}
        </div>

        {error ? <p className="customize-error">{error}</p> : null}

        <div className="customize-actions">
          <button type="button" className="btn" onClick={onClose} disabled={saving}>
            Cancel
          </button>
          <button type="button" className="btn btn-primary" onClick={apply} disabled={saving}>
            {saving ? "Applying…" : "Apply"}
          </button>
        </div>
      </div>

      <style jsx>{`
        .customize-overlay {
          position: fixed;
          inset: 0;
          background: rgba(15, 23, 42, 0.4);
          display: flex;
          align-items: center;
          justify-content: center;
          z-index: 1000;
        }
        .customize-panel {
          color-scheme: light;
          background: #fff;
          color: #0f172a;
          border-radius: 12px;
          padding: 20px;
          width: 360px;
          max-width: calc(100vw - 32px);
          max-height: calc(100vh - 64px);
          overflow-y: auto;
          box-shadow: 0 20px 60px rgba(0, 0, 0, 0.25);
        }
        .customize-header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          margin-bottom: 12px;
        }
        .customize-header h2 {
          font-size: 16px;
          margin: 0;
          color: #0f172a;
        }
        .customize-close {
          border: none;
          background: none;
          font-size: 20px;
          line-height: 1;
          cursor: pointer;
          color: #64748b;
        }
        .customize-fields {
          display: flex;
          flex-direction: column;
          gap: 10px;
        }
        .customize-field {
          display: flex;
          flex-direction: column;
          gap: 4px;
          font-size: 12px;
          color: #334155;
        }
        .customize-color-row {
          display: flex;
          gap: 8px;
        }
        .customize-color-row input[type="color"] {
          width: 36px;
          height: 32px;
          padding: 0;
          border: 1px solid #e2e8f0;
          border-radius: 6px;
          cursor: pointer;
        }
        .customize-color-row input[type="text"] {
          flex: 1;
          background: #fff;
          color: #0f172a;
          border: 1px solid #e2e8f0;
          border-radius: 6px;
          padding: 6px 8px;
          font-size: 13px;
        }
        .customize-error {
          color: #b91c1c;
          font-size: 12px;
          margin: 10px 0 0;
        }
        .customize-actions {
          display: flex;
          justify-content: flex-end;
          gap: 8px;
          margin-top: 16px;
        }
      `}</style>
    </div>
  );
}
