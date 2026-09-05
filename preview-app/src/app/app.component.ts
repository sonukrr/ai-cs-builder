import { Component, ElementRef, OnInit } from "@angular/core";
import { HttpClient } from "@angular/common/http";
import type { Blueprint, BlueprintPage, BlueprintSection } from "./blueprint";
import { themeVariables } from "./blueprint";
import { readConfig, type PreviewConfig } from "./preview-config";
import { datasetLabel, datasetSize } from "./mock/mock-data";

/**
 * The preview host.
 *
 * Renders one page of a Site Blueprint: functional sections become the real
 * `zm-careers-lib` components (see app.component.html), presentation sections
 * go to StaticSectionComponent. The blueprint arrives from the studio's API, so
 * this app holds no site definition of its own.
 *
 * Selection is reported to the studio over postMessage, which is what makes
 * click-to-edit work across the iframe boundary.
 */
@Component({
  selector: "app-root",
  templateUrl: "./app.component.html",
  styleUrls: ["./app.component.scss"],
})
export class AppComponent implements OnInit {
  config: PreviewConfig = readConfig(location.search);
  blueprint: Blueprint | null = null;
  page: BlueprintPage | null = null;
  error = "";
  loading = true;
  selectedId = "";

  constructor(
    private readonly http: HttpClient,
    private readonly host: ElementRef<HTMLElement>,
  ) {}

  ngOnInit(): void {
    this.load();

    // The studio drives page changes and selection without reloading the frame.
    window.addEventListener("message", (event: MessageEvent) => {
      const data = event.data as { type?: string; pageId?: string; sectionId?: string };
      if (data?.type === "preview:page" && data.pageId) this.showPage(data.pageId);
      if (data?.type === "preview:select") this.selectedId = data.sectionId ?? "";
    });
  }

  private load(): void {
    if (!this.config.projectId) {
      this.error = "No project was supplied. Open this preview from the studio.";
      this.loading = false;
      return;
    }

    const url = `${this.config.studioOrigin}/api/projects/${this.config.projectId}`;
    this.http.get<{ blueprint: Blueprint | null }>(url).subscribe({
      next: (response) => {
        this.loading = false;
        if (!response.blueprint) {
          this.error = "This project has no site yet.";
          return;
        }
        this.blueprint = response.blueprint;
        this.applyTheme(response.blueprint);
        this.showPage(this.config.pageId || response.blueprint.pages[0]?.id || "");
      },
      error: (caught) => {
        this.loading = false;
        this.error = `Could not load the site from the studio: ${caught?.message ?? caught}`;
      },
    });
  }

  private applyTheme(blueprint: Blueprint): void {
    const element = this.host.nativeElement;
    for (const [name, value] of Object.entries(themeVariables(blueprint))) {
      element.style.setProperty(name, value);
    }
  }

  showPage(pageId: string): void {
    if (!this.blueprint) return;
    this.page =
      this.blueprint.pages.find((candidate) => candidate.id === pageId) ?? this.blueprint.pages[0] ?? null;
  }

  select(section: BlueprintSection): void {
    this.selectedId = section.id;
    window.parent?.postMessage({ type: "preview:selected", sectionId: section.id }, "*");
  }

  get visibleSections(): BlueprintSection[] {
    return (this.page?.sections ?? []).filter((section) => section.visible);
  }

  /** The badge in the corner of the frame, so sample rows are never mistaken for real ones. */
  get dataSourceLabel(): string {
    if (this.config.source === "live") return "Live data";
    return this.config.source === "custom" ? `Sample · ${datasetSize()} roles` : "Sample data";
  }

  get dataSourceDetail(): string {
    return this.config.source === "live"
      ? `Live careers API at ${this.config.apiHost}`
      : datasetLabel();
  }

  /** Props are validated against the registry studio-side; read them plainly here. */
  prop(section: BlueprintSection, name: string, fallback: any = undefined): any {
    const value = section.props?.[name];
    return value === undefined || value === null ? fallback : value;
  }
}
