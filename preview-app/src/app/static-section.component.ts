import { Component, Input } from "@angular/core";
import type { BlueprintSection } from "./blueprint";

/**
 * Renders the presentation sections of a blueprint.
 *
 * These carry content only — never functional behaviour, which comes solely
 * from the approved library. One component with a switch rather than one
 * component per section type: the markup is small, the shapes are similar, and
 * a single file keeps the blueprint's content contract visible in one place.
 */
@Component({
  selector: "app-static-section",
  template: `
    <ng-container [ngSwitch]="section.type">
      <!-- Navigation -->
      <header *ngSwitchCase="'nav'" class="nav">
        <div class="wrap nav-inner">
          <span class="brand">{{ companyName }}</span>
          <nav>
            <a *ngFor="let item of nav" href="javascript:void(0)">{{ item.label }}</a>
          </nav>
        </div>
      </header>

      <!-- Hero. The image is a background, so it is decorative here and the
           headline carries the meaning; alt stays empty on purpose. -->
      <section *ngSwitchCase="'hero'" class="hero" [class.has-image]="image()">
        <img *ngIf="image()" class="hero-bg" [src]="image()" alt="" />
        <div class="wrap" [class.center]="value('alignment') === 'center'">
          <h1>{{ value('headline', 'Careers at ' + companyName) }}</h1>
          <p class="lede">{{ value('subhead', tagline) }}</p>
          <a *ngIf="value('ctaLabel')" class="btn" href="javascript:void(0)">{{ value('ctaLabel') }}</a>
        </div>
        <small *ngIf="credit() as c" class="credit">
          <a [href]="c.url" target="_blank" rel="noopener">{{ c.text }}</a>
        </small>
      </section>

      <!-- Card grids -->
      <section *ngSwitchCase="'value-props'" class="band">
        <div class="wrap">
          <h2>{{ value('headline', section.label) }}</h2>
          <div class="grid">
            <article *ngFor="let item of items">
              <h3>{{ item.title }}</h3>
              <p>{{ item.body }}</p>
            </article>
          </div>
        </div>
      </section>

      <section *ngSwitchCase="'benefits'" class="band">
        <div class="wrap">
          <h2>{{ value('headline', section.label) }}</h2>
          <div class="grid">
            <article *ngFor="let item of items">
              <h3>{{ item.title }}</h3>
              <p>{{ item.body }}</p>
            </article>
          </div>
        </div>
      </section>

      <section *ngSwitchCase="'employee-stories'" class="band tinted">
        <div class="wrap">
          <h2>{{ value('headline', 'Meet the team') }}</h2>
          <div class="grid">
            <article *ngFor="let item of items" class="card">
              <img
                *ngIf="itemImage(item, 'photo'); else noPhoto"
                class="photo"
                [src]="itemImage(item, 'photo')"
                [alt]="itemAlt(item, 'photo')"
                loading="lazy"
              />
              <ng-template #noPhoto><div class="photo empty"></div></ng-template>
              <h3>{{ item.name }}</h3>
              <p class="role">{{ item.role }}</p>
              <p>{{ item.quote }}</p>
            </article>
          </div>
        </div>
      </section>

      <section *ngSwitchCase="'testimonials'" class="band">
        <div class="wrap">
          <h2>{{ value('headline', section.label) }}</h2>
          <div class="grid">
            <blockquote *ngFor="let item of items">
              <p>{{ item.quote }}</p>
              <footer>{{ item.author }}<span *ngIf="item.role"> · {{ item.role }}</span></footer>
            </blockquote>
          </div>
        </div>
      </section>

      <section *ngSwitchCase="'stats'" class="band">
        <div class="wrap grid">
          <div *ngFor="let item of items">
            <div class="stat">{{ item.value }}</div>
            <p class="role">{{ item.label }}</p>
          </div>
        </div>
      </section>

      <section *ngSwitchCase="'culture'" class="band">
        <div class="wrap split">
          <div>
            <h2>{{ value('headline', section.label) }}</h2>
            <p class="lede">{{ value('body') }}</p>
          </div>
          <img *ngIf="image(); else noMedia" class="media" [src]="image()" [alt]="imageAlt()" loading="lazy" />
          <ng-template #noMedia><div class="media empty"></div></ng-template>
        </div>
      </section>

      <section *ngSwitchCase="'teams'" class="band">
        <div class="wrap">
          <h2>{{ value('headline', section.label) }}</h2>
          <div class="grid">
            <article *ngFor="let item of items" class="card">
              <img
                *ngIf="itemImage(item, 'image')"
                class="tile"
                [src]="itemImage(item, 'image')"
                [alt]="itemAlt(item, 'image')"
                loading="lazy"
              />
              <h3>{{ item.name || item.city }}</h3>
              <p>{{ item.body || item.country }}</p>
            </article>
          </div>
        </div>
      </section>

      <section *ngSwitchCase="'locations'" class="band">
        <div class="wrap">
          <h2>{{ value('headline', section.label) }}</h2>
          <div class="grid">
            <article *ngFor="let item of items" class="card">
              <img
                *ngIf="itemImage(item, 'image')"
                class="tile"
                [src]="itemImage(item, 'image')"
                [alt]="itemAlt(item, 'image')"
                loading="lazy"
              />
              <h3>{{ item.city || item.name }}</h3>
              <p>{{ item.country || item.body }}</p>
            </article>
          </div>
        </div>
      </section>

      <section *ngSwitchCase="'process'" class="band narrow">
        <div class="wrap">
          <h2>{{ value('headline', section.label) }}</h2>
          <div *ngFor="let item of items; index as i" class="row">
            <h3>{{ item.title || 'Step ' + (i + 1) }}</h3>
            <p>{{ item.body }}</p>
          </div>
        </div>
      </section>

      <section *ngSwitchCase="'faq'" class="band narrow">
        <div class="wrap">
          <h2>{{ value('headline', section.label) }}</h2>
          <div *ngFor="let item of items" class="row">
            <h3>{{ item.question }}</h3>
            <p>{{ item.answer }}</p>
          </div>
        </div>
      </section>

      <section *ngSwitchCase="'cta'" class="cta">
        <div class="wrap center">
          <h2>{{ value('headline', 'Ready when you are') }}</h2>
          <p>{{ value('body') }}</p>
          <a *ngIf="value('ctaLabel')" class="btn inverse" href="javascript:void(0)">{{ value('ctaLabel') }}</a>
        </div>
      </section>

      <section *ngSwitchCase="'logo-wall'" class="band">
        <div class="wrap">
          <h2>{{ value('headline', section.label) }}</h2>
          <div class="grid">
            <div *ngFor="let item of items" class="logo">
              <img
                *ngIf="itemImage(item, 'image'); else logoName"
                [src]="itemImage(item, 'image')"
                [alt]="item.name || ''"
                loading="lazy"
              />
              <ng-template #logoName>{{ item.name }}</ng-template>
            </div>
          </div>
        </div>
      </section>

      <section *ngSwitchCase="'media'" class="band">
        <div class="wrap">
          <img *ngIf="image(); else noTall" class="media tall" [src]="image()" [alt]="imageAlt()" loading="lazy" />
          <ng-template #noTall><div class="media tall empty"></div></ng-template>
          <p *ngIf="value('caption')" class="role">{{ value('caption') }}</p>
          <small *ngIf="credit() as c" class="credit inline">
            <a [href]="c.url" target="_blank" rel="noopener">{{ c.text }}</a>
          </small>
        </div>
      </section>

      <footer *ngSwitchCase="'footer'" class="site-footer">
        <div class="wrap footer-inner">
          <span class="brand">{{ companyName }}</span>
          <nav>
            <a *ngFor="let item of nav" href="javascript:void(0)">{{ item.label }}</a>
          </nav>
        </div>
        <div class="wrap legal">{{ value('legal', '© ' + year + ' ' + companyName) }}</div>
      </footer>

      <!-- rich-text, and anything the studio adds that we do not know yet -->
      <section *ngSwitchDefault class="band narrow">
        <div class="wrap">
          <h2 *ngIf="value('headline')">{{ value('headline') }}</h2>
          <p class="lede">{{ value('body', section.label) }}</p>
        </div>
      </section>
    </ng-container>
  `,
  styleUrls: ["./static-section.component.scss"],
})
export class StaticSectionComponent {
  @Input() section!: BlueprintSection;
  @Input() companyName = "";
  @Input() tagline = "";
  @Input() nav: { label: string }[] = [];
  /** Uploads and placeholders are served by the studio, on its own origin. */
  @Input() studioOrigin = "";

  readonly year = new Date().getFullYear();

  /** Content lookup with a fallback, so a missing field never renders "undefined". */
  value(key: string, fallback = ""): string {
    const raw = this.section?.content?.[key];
    return typeof raw === "string" && raw.trim() ? raw : fallback;
  }

  get items(): Record<string, any>[] {
    const raw = this.section?.content?.["items"];
    return Array.isArray(raw) ? raw : [];
  }

  /**
   * Resolves an image URL for display in the frame.
   *
   * Uploads and generated placeholders are stored as studio-relative paths
   * (`/api/…`) so they survive the site moving between environments. Inside
   * this iframe a relative path would resolve against the preview host, so it
   * is rebased onto the studio. Absolute URLs — stock photography — pass
   * through untouched.
   */
  src(url: string): string {
    if (!url) return "";
    if (/^(https?:)?\/\//.test(url) || url.startsWith("data:")) return url;
    return `${this.studioOrigin}${url.startsWith("/") ? "" : "/"}${url}`;
  }

  /** The image on the section itself, if it has one. */
  image(key = "image"): string {
    return this.src(this.value(key));
  }

  imageAlt(key = "image"): string {
    return this.value(`${key}Alt`) || this.value("headline") || this.section?.label || "";
  }

  /** Per-item imagery: employee photos, team tiles, location cards. */
  itemImage(item: Record<string, any>, key: string): string {
    const raw = item?.[key];
    return typeof raw === "string" ? this.src(raw) : "";
  }

  itemAlt(item: Record<string, any>, key: string): string {
    return String(item?.[`${key}Alt`] ?? item?.["name"] ?? item?.["city"] ?? "");
  }

  credit(key = "image"): { text: string; url: string } | null {
    const raw = this.section?.content?.[`${key}Credit`];
    return raw && typeof raw === "object" ? (raw as { text: string; url: string }) : null;
  }
}
