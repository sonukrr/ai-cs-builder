import { Injectable, NgZone } from "@angular/core";

/**
 * The width of the frame the preview is rendering into.
 *
 * A layout container collapses to one column below its own `stackBelow` px,
 * and that threshold is per-container blueprint data. A CSS media query cannot
 * express it — a query needs a literal breakpoint, and `@container` cannot take
 * a dynamic threshold either — so the comparison has to happen in TypeScript
 * and the width has to come from somewhere. Reading `window.innerWidth` inside
 * a getter would mean touching layout on every change-detection pass, so it is
 * read once per resize instead.
 *
 * This is a single listener shared by every section rather than one per
 * component: a page can hold dozens of sections and they all want the same
 * number. The preview runs inside the studio's device frame, so `innerWidth`
 * here is the simulated viewport width — exactly the number the emitted site's
 * media query will compare against in a real browser.
 */
@Injectable({ providedIn: "root" })
export class ViewportService {
  width = window.innerWidth;

  constructor(zone: NgZone) {
    // Registered inside the zone on purpose: the resize is what makes a
    // container stack, so it has to run change detection.
    zone.run(() => {
      window.addEventListener("resize", () => (this.width = window.innerWidth));
    });
  }
}
