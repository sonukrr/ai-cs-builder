"use client";

import { useEffect, useMemo, useRef, useState } from "react";

/**
 * The catalog of everything that can go on a page.
 *
 * The conversation is good at intent — "make this feel more like an engineering
 * site" — and bad at discovery. An administrator cannot ask for a capability
 * they do not know exists, and reading a list back over chat is a poor way to
 * browse thirty things. So the catalog is a panel: grouped, searchable, and one
 * click to add.
 *
 * Everything here is named the way an administrator would name it. Internal
 * component names never reach this component — see /api/components.
 */

interface CatalogItem {
  id: string;
  name: string;
  blurb: string;
  kind: "functional" | "content";
  source: "zm-careers-lib" | "custom";
  capabilities: string[];
  settings: { name: string; description: string }[];
  takesImage: boolean;
}

interface CatalogGroup {
  id: string;
  name: string;
  blurb: string;
  items: CatalogItem[];
}

interface Catalog {
  library: { name: string; version: string; approvedCount: number };
  functional: CatalogGroup[];
  content: CatalogGroup[];
}

interface Props {
  projectId: string;
  pageId: string;
  pageName: string;
  onClose: () => void;
  onAdded: () => void;
}

export function ComponentCatalog({ projectId, pageId, pageName, onClose, onAdded }: Props) {
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [query, setQuery] = useState("");
  const [tab, setTab] = useState<"functional" | "content">("functional");
  const [expanded, setExpanded] = useState<string>("");
  const [adding, setAdding] = useState("");
  const [error, setError] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    fetch("/api/components")
      .then((response) => response.json())
      .then(setCatalog)
      .catch((caught) => setError(String(caught)));
  }, []);

  useEffect(() => {
    searchRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Searching should cross the tab boundary — someone typing "resume" wants the
  // upload whether or not they know it counts as "functional".
  const groups = useMemo(() => {
    if (!catalog) return [];
    const all = tab === "functional" ? catalog.functional : catalog.content;
    const needle = query.trim().toLowerCase();
    if (!needle) return all;

    return all
      .map((group) => ({
        ...group,
        items: group.items.filter((item) =>
          [item.name, item.blurb, item.id, ...item.capabilities]
            .join(" ")
            .toLowerCase()
            .includes(needle),
        ),
      }))
      .filter((group) => group.items.length > 0);
  }, [catalog, tab, query]);

  const matchesInOtherTab = useMemo(() => {
    if (!catalog || !query.trim()) return 0;
    const other = tab === "functional" ? catalog.content : catalog.functional;
    const needle = query.trim().toLowerCase();
    return other
      .flatMap((group) => group.items)
      .filter((item) => [item.name, item.blurb, item.id].join(" ").toLowerCase().includes(needle))
      .length;
  }, [catalog, tab, query]);

  async function add(item: CatalogItem) {
    setAdding(item.id);
    setError("");
    try {
      const response = await fetch(`/api/projects/${projectId}/sections`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pageId, type: item.id, source: item.source }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? "Could not add that");
      onAdded();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setAdding("");
    }
  }

  return (
    <div className="catalog-backdrop" onClick={onClose}>
      <div className="catalog" onClick={(event) => event.stopPropagation()} role="dialog" aria-label="Add a section">
        <header className="catalog-head">
          <div>
            <strong>Add to {pageName}</strong>
            <div className="faint" style={{ fontSize: 12.5 }}>
              {catalog
                ? `${catalog.library.approvedCount} approved capabilities · ${catalog.library.name}@${catalog.library.version}`
                : "Loading…"}
            </div>
          </div>
          <button className="btn btn-sm" onClick={onClose}>
            Close
          </button>
        </header>

        <div className="catalog-controls">
          <input
            ref={searchRef}
            className="field"
            placeholder="Search — try “filter”, “resume”, “benefits”…"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          <div className="catalog-tabs">
            <button
              className={`btn btn-sm ${tab === "functional" ? "is-on" : ""}`}
              onClick={() => setTab("functional")}
            >
              Job features
            </button>
            <button
              className={`btn btn-sm ${tab === "content" ? "is-on" : ""}`}
              onClick={() => setTab("content")}
            >
              Content sections
            </button>
          </div>
        </div>

        <div className="catalog-body">
          {error && (
            <div className="notice" style={{ borderLeftColor: "var(--bad)", margin: "0 0 12px" }}>
              {error}
            </div>
          )}

          {catalog && groups.length === 0 && (
            <div className="faint" style={{ padding: "24px 2px", fontSize: 13.5 }}>
              Nothing here matches “{query}”.
              {matchesInOtherTab > 0 && (
                <>
                  {" "}
                  <button
                    className="btn btn-sm"
                    onClick={() => setTab(tab === "functional" ? "content" : "functional")}
                  >
                    {matchesInOtherTab} match{matchesInOtherTab === 1 ? "" : "es"} in{" "}
                    {tab === "functional" ? "Content sections" : "Job features"}
                  </button>
                </>
              )}
            </div>
          )}

          {groups.map((group) => (
            <section key={group.id} className="catalog-group">
              <h3>{group.name}</h3>
              <p className="faint">{group.blurb}</p>

              {group.items.map((item) => (
                <article key={item.id} className="catalog-item">
                  <div className="catalog-item-main">
                    <div className="catalog-item-title">
                      <strong>{item.name}</strong>
                      {item.kind === "functional" && <span className="tag tag-fn">live data</span>}
                      {item.takesImage && <span className="tag">image</span>}
                    </div>
                    <div className="muted" style={{ fontSize: 13 }}>
                      {item.blurb}
                    </div>

                    {expanded === item.id && item.settings.length > 0 && (
                      <dl className="catalog-settings">
                        {item.settings.map((setting) => (
                          <div key={setting.name}>
                            <dt>{setting.name}</dt>
                            <dd>{setting.description}</dd>
                          </div>
                        ))}
                      </dl>
                    )}
                  </div>

                  <div className="catalog-item-actions">
                    <button className="btn btn-primary btn-sm" onClick={() => add(item)} disabled={adding !== ""}>
                      {adding === item.id ? "Adding…" : "Add"}
                    </button>
                    {item.settings.length > 0 && (
                      <button
                        className="btn btn-sm"
                        onClick={() => setExpanded(expanded === item.id ? "" : item.id)}
                      >
                        {expanded === item.id ? "Less" : "Options"}
                      </button>
                    )}
                  </div>
                </article>
              ))}
            </section>
          ))}
        </div>

        <footer className="catalog-foot faint">
          Job features are backed by the approved library and show live jobs once published. Content
          sections hold your own copy and imagery.
        </footer>
      </div>
    </div>
  );
}
