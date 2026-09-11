"use client";

import { useState } from "react";
import type { Blueprint, DesignTokens } from "@/lib/blueprint/schema";
import { CloseIcon } from "@/components/studio/icons";

/**
 * Live style editing — colors and company copy, outside the conversational
 * agent path.
 *
 * Saving PATCHes `/api/projects/[projectId]/brand`, which merges into the
 * current blueprint and commits a new version the same way every other edit
 * does. The caller reloads the blueprint and re-broadcasts to any open
 * full-preview tab; this panel only owns the form and the save request.
 */

type ColorKey = keyof DesignTokens["colors"];

const COLOR_FIELDS: { key: ColorKey; label: string; required: boolean }[] = [
  { key: "primary", label: "Primary", required: true },
  { key: "secondary", label: "Secondary", required: true },
  { key: "accent", label: "Accent", required: false },
  { key: "background", label: "Background", required: true },
  { key: "surface", label: "Surface", required: false },
  { key: "text", label: "Text", required: true },
  { key: "muted", label: "Muted", required: false },
  { key: "border", label: "Border", required: false },
];

const HEX_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;

interface Props {
  projectId: string;
  blueprint: Blueprint;
  onClose: () => void;
  /** Called with the saved blueprint so the studio can refresh and re-broadcast. */
  onSaved: (blueprint: Blueprint) => void;
}

export function StyleEditor({ projectId, blueprint, onClose, onSaved }: Props) {
  const [companyName, setCompanyName] = useState(blueprint.company.name);
  const [tagline, setTagline] = useState(blueprint.company.tagline);
  const [colors, setColors] = useState<Record<ColorKey, string>>(() => {
    const initial = {} as Record<ColorKey, string>;
    for (const { key } of COLOR_FIELDS) initial[key] = blueprint.company.brand.tokens.colors[key] ?? "";
    return initial;
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  function setColor(key: ColorKey, value: string) {
    setColors((current) => ({ ...current, [key]: value }));
  }

  async function save() {
    if (saving) return;
    for (const { key, label, required } of COLOR_FIELDS) {
      const value = colors[key];
      if (!value && !required) continue;
      if (!HEX_RE.test(value)) {
        setError(`${label} needs a hex colour, e.g. #1a1a1a`);
        return;
      }
    }

    setSaving(true);
    setError("");
    try {
      const cleanedColors: Partial<DesignTokens["colors"]> = {};
      for (const { key } of COLOR_FIELDS) if (colors[key]) cleanedColors[key] = colors[key];

      const response = await fetch(`/api/projects/${projectId}/brand`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          companyName: companyName.trim(),
          tagline,
          colors: cleanedColors,
        }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error ?? "Could not save the style changes");
      onSaved(body.blueprint as Blueprint);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="catalog-backdrop" onClick={saving ? undefined : onClose}>
      <div className="catalog style-editor" onClick={(event) => event.stopPropagation()}>
        <div className="catalog-head">
          <div>
            <strong>Edit styles</strong>
            <div className="faint" style={{ fontSize: 12.5 }}>
              Colours and company copy — saved to the site and reflected everywhere it renders.
            </div>
          </div>
          <span style={{ flex: 1 }} />
          <button className="btn btn-sm" onClick={onClose} disabled={saving}>
            <CloseIcon size={12} />
          </button>
        </div>

        <div className="catalog-body">
          <div className="publish-section">
            <label className="publish-label" htmlFor="style-company-name">
              Company name
            </label>
            <input
              id="style-company-name"
              className="field"
              value={companyName}
              onChange={(event) => setCompanyName(event.target.value)}
            />
          </div>

          <div className="publish-section">
            <label className="publish-label" htmlFor="style-tagline">
              Tagline
            </label>
            <input
              id="style-tagline"
              className="field"
              value={tagline}
              onChange={(event) => setTagline(event.target.value)}
            />
          </div>

          <div className="publish-section">
            <div className="publish-label">Brand colours</div>
            <div className="color-grid">
              {COLOR_FIELDS.map(({ key, label }) => (
                <label className="color-row" key={key}>
                  <input
                    type="color"
                    value={HEX_RE.test(colors[key]) ? colors[key].slice(0, 7) : "#ffffff"}
                    onChange={(event) => setColor(key, event.target.value)}
                  />
                  <span className="color-label">{label}</span>
                  <input
                    type="text"
                    value={colors[key]}
                    onChange={(event) => setColor(key, event.target.value)}
                    placeholder="—"
                    spellCheck={false}
                  />
                </label>
              ))}
            </div>
          </div>

          {error && (
            <div className="notice" style={{ borderLeftColor: "var(--l-bad)" }}>
              {error}
            </div>
          )}
        </div>

        <div className="catalog-foot">
          <span className="faint" style={{ fontSize: 12 }}>
            Saves as a new version — visible in History and revertible like any other change.
          </span>
          <span style={{ flex: 1 }} />
          <button className="btn btn-primary" onClick={save} disabled={saving}>
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}
