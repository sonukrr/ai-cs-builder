import { readFile } from "node:fs/promises";
import type { DesignDocument, DesignFrame, DesignNode, FigmaProvider } from "./types";
import { collectStyles } from "./rest";

/**
 * Demo backend — a plausible careers design, with no credentials required.
 *
 * 10-claude-code-build-instructions.md is explicit that UI work must not block
 * on MCP credentials, so this is a first-class backend rather than a test stub:
 * the whole Figma import flow, including the semantic analysis, runs against it
 * end to end. Set FIGMA_FIXTURE to a real `/v1/files/:key` JSON dump to drive
 * the same path with a genuine design.
 *
 * The fixture is deliberately *messy* in the way real designs are — layers are
 * named "Section / Stories", "Group 47", "Frame 12" rather than "employee
 * stories" — so the semantic analysis is actually doing work instead of reading
 * labels that already contain the answer.
 */

const BRAND = {
  primary: "#0f2a4a",
  accent: "#e2483d",
  ink: "#101418",
  muted: "#5b6672",
  surface: "#f4f6f8",
  white: "#ffffff",
};

let autoId = 0;
const nextId = () => `${++autoId}:${autoId * 7}`;

interface Opts {
  fills?: string[];
  fontSize?: number;
  fontWeight?: number;
  fontFamily?: string;
  text?: string;
  componentName?: string;
}

function node(type: string, name: string, height: number, opts: Opts = {}, children: DesignNode[] = []): DesignNode {
  return {
    id: nextId(),
    name,
    type,
    bounds: { x: 0, y: 0, width: 1440, height },
    ...(opts.text ? { text: opts.text } : {}),
    ...(opts.fills ? { fills: opts.fills } : {}),
    ...(opts.fontSize ? { fontSize: opts.fontSize } : {}),
    ...(opts.fontWeight ? { fontWeight: opts.fontWeight } : {}),
    ...(opts.fontFamily ? { fontFamily: opts.fontFamily } : {}),
    ...(opts.componentName ? { componentName: opts.componentName } : {}),
    ...(children.length > 0 ? { children } : {}),
  };
}

const heading = (text: string, size: number) =>
  node("TEXT", text.slice(0, 32), size * 1.2, {
    text,
    fontSize: size,
    fontWeight: 700,
    fontFamily: "Söhne",
    fills: [BRAND.ink],
  });

const body = (text: string) =>
  node("TEXT", text.slice(0, 24), 24, {
    text,
    fontSize: 16,
    fontWeight: 400,
    fontFamily: "Söhne",
    fills: [BRAND.muted],
  });

const button = (label: string) =>
  node("INSTANCE", "Button / Primary", 48, {
    componentName: "Button",
    fills: [BRAND.accent],
  }, [node("TEXT", label, 20, { text: label, fontSize: 16, fontWeight: 600, fills: [BRAND.white] })]);

function buildFrames(): DesignFrame[] {
  autoId = 0;

  const navBar = node("FRAME", "Global / Top bar", 72, { fills: [BRAND.white] }, [
    node("RECTANGLE", "Logo", 32, { fills: [BRAND.primary] }),
    node("TEXT", "Link", 20, { text: "Life at Northwind", fontSize: 15, fills: [BRAND.ink] }),
    node("TEXT", "Link", 20, { text: "Teams", fontSize: 15, fills: [BRAND.ink] }),
    node("TEXT", "Link", 20, { text: "Open Roles", fontSize: 15, fills: [BRAND.ink] }),
    node("TEXT", "Link", 20, { text: "Benefits", fontSize: 15, fills: [BRAND.ink] }),
  ]);

  const siteFooter = node("FRAME", "Global / Bottom", 320, { fills: [BRAND.primary] }, [
    node("TEXT", "col-title", 20, { text: "Explore", fontSize: 14, fontWeight: 600, fills: [BRAND.white] }),
    node("TEXT", "col-title", 20, { text: "Open Roles", fontSize: 14, fills: [BRAND.white] }),
    node("TEXT", "col-title", 20, { text: "Our Teams", fontSize: 14, fills: [BRAND.white] }),
    node("TEXT", "legal", 18, { text: "© 2026 Northwind Labs. All rights reserved.", fontSize: 13, fills: [BRAND.white] }),
  ]);

  const home: DesignFrame = {
    id: nextId(),
    name: "Desktop / Home",
    bounds: { x: 0, y: 0, width: 1440, height: 4200 },
    children: [
      navBar,
      // Deliberately vague layer name — the analyzer has to read the contents.
      node("FRAME", "Frame 12", 640, { fills: [BRAND.primary] }, [
        heading("Build what the world runs on", 56),
        body("Northwind Labs is hiring engineers, designers and operators across nine countries."),
        button("See open roles"),
        node("RECTANGLE", "Image placeholder", 480, { fills: [BRAND.surface] }),
      ]),
      node("FRAME", "Search block", 180, { fills: [BRAND.white] }, [
        node("RECTANGLE", "Input", 56, { fills: [BRAND.surface] }, [
          node("TEXT", "placeholder", 20, { text: "Search roles by title or keyword", fontSize: 16, fills: [BRAND.muted] }),
        ]),
        button("Search"),
      ]),
      node("FRAME", "Group 47", 520, { fills: [BRAND.white] }, [
        heading("Why people stay", 36),
        node("FRAME", "card", 240, {}, [
          heading("Real ownership", 20),
          body("Small teams, wide scope, and the room to ship what you believe in."),
        ]),
        node("FRAME", "card", 240, {}, [
          heading("Deep craft", 20),
          body("We hire specialists and give them the time to do the work properly."),
        ]),
        node("FRAME", "card", 240, {}, [
          heading("Work that lasts", 20),
          body("Infrastructure used by two million businesses every day."),
        ]),
      ]),
      node("FRAME", "Section / Stories", 620, { fills: [BRAND.surface] }, [
        heading("Meet the team", 36),
        node("FRAME", "person", 380, {}, [
          node("RECTANGLE", "Photo", 240, { fills: [BRAND.muted] }),
          heading("Amara Osei", 18),
          body("Staff Engineer, Payments"),
          body("“I joined to work on one hard problem and stayed for the people solving the next nine.”"),
        ]),
        node("FRAME", "person", 380, {}, [
          node("RECTANGLE", "Photo", 240, { fills: [BRAND.muted] }),
          heading("Tomas Lindqvist", 18),
          body("Design Lead, Platform"),
          body("“Design here is not decoration. It is half the argument.”"),
        ]),
      ]),
      node("FRAME", "Perks", 480, { fills: [BRAND.white] }, [
        heading("Benefits", 36),
        node("FRAME", "perk", 180, {}, [heading("Health cover", 18), body("Full medical, dental and vision from day one.")]),
        node("FRAME", "perk", 180, {}, [heading("Learning budget", 18), body("£2,000 a year, no approval needed.")]),
        node("FRAME", "perk", 180, {}, [heading("Flexible working", 18), body("Remote-first with offices in six cities.")]),
        node("FRAME", "perk", 180, {}, [heading("Parental leave", 18), body("Six months, fully paid, for every parent.")]),
      ]),
      node("FRAME", "Frame 88", 280, { fills: [BRAND.accent] }, [
        heading("Ready when you are", 40),
        body("Browse every open role across engineering, design, sales and operations."),
        button("Browse all jobs"),
      ]),
      siteFooter,
    ],
  };

  const jobs: DesignFrame = {
    id: nextId(),
    name: "Desktop / Roles",
    bounds: { x: 1600, y: 0, width: 1440, height: 2400 },
    children: [
      navBar,
      node("FRAME", "Page header", 200, { fills: [BRAND.white] }, [
        heading("Open roles", 44),
        body("142 positions across 9 countries"),
      ]),
      node("FRAME", "Search block", 120, { fills: [BRAND.surface] }, [
        node("RECTANGLE", "Input", 56, { fills: [BRAND.white] }, [
          node("TEXT", "placeholder", 20, { text: "Search roles", fontSize: 16, fills: [BRAND.muted] }),
        ]),
      ]),
      node("FRAME", "Left rail", 900, { fills: [BRAND.white] }, [
        heading("Filter", 20),
        node("FRAME", "facet", 160, {}, [
          heading("Department", 15),
          body("Engineering"),
          body("Design"),
          body("Sales"),
        ]),
        node("FRAME", "facet", 160, {}, [
          heading("Location", 15),
          body("London"),
          body("Berlin"),
          body("Remote"),
        ]),
        node("FRAME", "facet", 120, {}, [heading("Experience", 15), body("0-2 years"), body("3-5 years")]),
      ]),
      node("FRAME", "Results", 900, { fills: [BRAND.white] }, [
        node("FRAME", "row", 140, {}, [
          heading("Senior Backend Engineer", 20),
          body("Engineering · London · Full time"),
          button("Apply"),
        ]),
        node("FRAME", "row", 140, {}, [
          heading("Product Designer", 20),
          body("Design · Remote · Full time"),
          button("Apply"),
        ]),
        node("FRAME", "row", 140, {}, [
          heading("Solutions Engineer", 20),
          body("Sales · Berlin · Full time"),
          button("Apply"),
        ]),
      ]),
      node("FRAME", "Pager", 80, {}, [
        node("TEXT", "page", 20, { text: "1", fontSize: 14, fills: [BRAND.ink] }),
        node("TEXT", "page", 20, { text: "2", fontSize: 14, fills: [BRAND.muted] }),
        node("TEXT", "page", 20, { text: "3", fontSize: 14, fills: [BRAND.muted] }),
        node("TEXT", "page", 20, { text: "Next", fontSize: 14, fills: [BRAND.muted] }),
      ]),
      siteFooter,
    ],
  };

  const detail: DesignFrame = {
    id: nextId(),
    name: "Desktop / Role detail",
    bounds: { x: 3200, y: 0, width: 1440, height: 2200 },
    children: [
      navBar,
      node("FRAME", "Role header", 240, { fills: [BRAND.surface] }, [
        heading("Senior Backend Engineer", 40),
        body("Engineering · London · Full time"),
        button("Apply for this role"),
      ]),
      node("FRAME", "Body copy", 900, { fills: [BRAND.white] }, [
        heading("About the role", 24),
        body("You will own the payments ledger end to end."),
        heading("What we look for", 24),
        body("Five years building distributed systems in production."),
      ]),
      node("FRAME", "Application", 700, { fills: [BRAND.white] }, [
        heading("Apply", 28),
        node("RECTANGLE", "Dropzone", 180, { fills: [BRAND.surface] }, [
          node("TEXT", "hint", 20, { text: "Drag your CV here, or browse files", fontSize: 15, fills: [BRAND.muted] }),
        ]),
        node("RECTANGLE", "Field", 56, { fills: [BRAND.surface] }, [
          node("TEXT", "label", 20, { text: "Full name", fontSize: 14, fills: [BRAND.muted] }),
        ]),
        node("RECTANGLE", "Field", 56, { fills: [BRAND.surface] }, [
          node("TEXT", "label", 20, { text: "Email address", fontSize: 14, fills: [BRAND.muted] }),
        ]),
        button("Submit application"),
      ]),
      siteFooter,
    ],
  };

  return [home, jobs, detail];
}

export class FigmaMockProvider implements FigmaProvider {
  readonly backend = "mock" as const;

  private readonly fixturePath?: string;

  constructor(fixturePath?: string) {
    this.fixturePath = fixturePath;
  }

  async fetchDesign(fileKey: string): Promise<DesignDocument> {
    if (this.fixturePath) {
      const raw = JSON.parse(await readFile(this.fixturePath, "utf8"));
      // A real /v1/files/:key dump; reuse the REST normalizer's shape contract.
      if (raw.frames && raw.styles) return { ...raw, backend: this.backend } as DesignDocument;
    }

    const frames = buildFrames();
    return {
      fileKey: fileKey || "demo-northwind",
      fileName: "Northwind Labs — Careers",
      lastModified: new Date().toISOString(),
      backend: this.backend,
      frames,
      styles: collectStyles(frames),
      images: {},
      warnings: [
        "This is the built-in demo design. Set FIGMA_PROVIDER=mcp or =rest to import a real file.",
      ],
    };
  }
}
