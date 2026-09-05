import { Component, EventEmitter, Input, Output } from "@angular/core";
import type {
  Blueprint,
  BlueprintSection,
  LayoutAlign,
  LayoutProps,
  SectionLayout,
} from "./blueprint";
import { isLayoutSection, layoutProps } from "./blueprint";
import { isMocked, type PreviewConfig } from "./preview-config";
import { mockRecommendations } from "./mock/mock-data";
import { ViewportService } from "./viewport.service";

/** start/end are flex-box's flex-start/flex-end; grid accepts both spellings. */
const ALIGN: Record<LayoutAlign, string> = {
  start: "flex-start",
  center: "center",
  end: "flex-end",
  stretch: "stretch",
};

/**
 * Renders one section of a blueprint, and recurses.
 *
 * Sections form a tree: a `source: "layout"` section renders no component of
 * its own, only a flex/grid box holding its children — each of which is
 * another app-section-host, which is why this component references itself.
 * Everything else is a leaf: an approved zm-careers-lib component, or
 * StaticSectionComponent for presentation sections.
 *
 * This lives apart from AppComponent because the per-section markup is the one
 * thing a container has to be able to repeat; leaving it inline in the page
 * template made the flat list the only shape a page could have.
 */
@Component({
  selector: "app-section-host",
  templateUrl: "./section-host.component.html",
  styleUrls: ["./section-host.component.scss"],
})
export class SectionHostComponent {
  @Input() section!: BlueprintSection;
  @Input() selectedId = "";
  @Input() blueprint: Blueprint | null = null;
  @Input() config!: PreviewConfig;
  /** True for a section rendered by a container, which changes how it is sized. */
  @Input() inLayout = false;

  /**
   * Reports the clicked section id upwards. Nested hosts pass it along rather
   * than talking to the studio themselves, so the one postMessage that crosses
   * the iframe boundary stays in AppComponent.
   */
  @Output() select = new EventEmitter<string>();

  constructor(private readonly viewport: ViewportService) {}

  /**
   * `lib-job-recommendation` takes its rows as an input rather than fetching
   * them, so the interceptor cannot reach it and the binding is the only place
   * this section can get data. Held in a field, not a getter: it is bound inside
   * a template expression that Angular re-evaluates on every change detection
   * pass, and a getter would hand the component a new array each time and keep
   * the pass from ever settling.
   *
   * Live mode gets an empty list on purpose — the real recommendations come
   * back from the resume parser once a candidate has uploaded a CV, and showing
   * the sample roles there would be a live section quietly displaying fixtures.
   */
  private recommendations: { jobTitle: string; location: string; jobUrl: string }[] | null = null;

  get recommendedJobs(): { jobTitle: string; location: string; jobUrl: string }[] {
    if (this.recommendations === null) {
      this.recommendations = isMocked(this.config.source) ? mockRecommendations() : [];
    }
    return this.recommendations;
  }

  get isLayout(): boolean {
    return isLayoutSection(this.section);
  }

  get props(): LayoutProps {
    return layoutProps(this.section?.props);
  }

  get children(): BlueprintSection[] {
    return (this.section?.children ?? []).filter((child) => child.visible);
  }

  /** Below `stackBelow` a row or grid becomes a single column. 0 disables it. */
  get stacked(): boolean {
    const props = this.props;
    if (props.direction === "column" || props.stackBelow <= 0) return false;
    return this.viewport.width < props.stackBelow;
  }

  /** The container box itself. Kept identical to the React and Angular emitters. */
  get containerStyle(): Record<string, string> {
    const props = this.props;
    const stacked = this.stacked;
    const style: Record<string, string> = {
      gap: `${props.gap}px`,
      "align-items": ALIGN[props.align],
      "justify-content": props.justify.startsWith("space")
        ? props.justify
        : ALIGN[props.justify as LayoutAlign],
    };

    if (props.direction === "grid") {
      style["display"] = "grid";
      style["grid-template-columns"] = stacked
        ? "1fr"
        : `repeat(${props.columns}, minmax(0, 1fr))`;
    } else {
      style["display"] = "flex";
      if (props.direction === "row") {
        style["flex-direction"] = stacked
          ? props.reverseOnMobile
            ? "column-reverse"
            : "column"
          : "row";
        style["flex-wrap"] = props.wrap ? "wrap" : "nowrap";
      } else {
        style["flex-direction"] = "column";
      }
    }

    if (props.padding > 0) style["padding"] = `${props.padding}px`;
    if (props.maxWidth > 0) {
      style["max-width"] = `${props.maxWidth}px`;
      style["margin-inline"] = "auto";
    }
    if (props.background) style["background"] = props.background;

    return style;
  }

  /**
   * One child's placement, from its own `layout`.
   *
   * The flex shorthand is what makes the driving example work. `grow` defaults
   * to 1 so children with no placement at all share the row equally
   * (`flex: 1 1 0%`), but to 0 once a `basis` is given: the facets column asks
   * for `basis: "300px"` and nothing else, and it is meant to settle at 300px
   * rather than grow past it. The job list asks for `grow: 1` and takes the
   * rest. Once the container has stacked, both flex and span are dropped — a
   * basis of 300px in a column would be a 300px *height*.
   */
  childStyle(child: BlueprintSection, index: number): Record<string, string> {
    const placement: SectionLayout = child.layout ?? {};
    const props = this.props;
    const stacked = this.stacked;
    const style: Record<string, string> = {};

    if (props.direction === "grid" && !stacked && placement.span) {
      style["grid-column"] = `span ${placement.span}`;
    }
    if (props.direction === "row") {
      const grow = placement.grow ?? (placement.basis ? 0 : 1);
      style["flex"] = stacked ? "0 0 auto" : `${grow} 1 ${placement.basis ?? "0%"}`;
    }
    if (placement.align) style["align-self"] = ALIGN[placement.align];

    // A stacked grid cannot use column-reverse, so reversing it means ordering
    // the items by hand. Grid honours `order` the same way flex does.
    if (stacked && props.direction === "grid" && props.reverseOnMobile) {
      style["order"] = String(this.children.length - index);
    } else if (placement.order !== undefined) {
      style["order"] = String(placement.order);
    }

    return style;
  }

  /**
   * A nested section sits inside its container's own `.section` box, so without
   * stopping the click here it would select the child and then every ancestor
   * container in turn, leaving the outermost one selected.
   */
  onClick(event: MouseEvent): void {
    event.stopPropagation();
    this.select.emit(this.section.id);
  }

  /** Props are validated against the registry studio-side; read them plainly here. */
  prop(section: BlueprintSection, name: string, fallback: any = undefined): any {
    const value = section.props?.[name];
    return value === undefined || value === null ? fallback : value;
  }
}
