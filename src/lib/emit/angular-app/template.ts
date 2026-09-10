/**
 * The presentation sections' template and stylesheet.
 *
 * A port of `preview-app/src/app/static-section.component`, kept separate from
 * the rest of the runtime only because it is long. Two deliberate differences
 * from the preview, both because this one is a real site rather than a picture
 * of one:
 *
 *  - navigation and calls to action are real links. The preview renders
 *    `href="javascript:void(0)"` because it has nowhere to navigate to; a
 *    published site routes, so an internal target becomes a `routerLink` and an
 *    external one an `href`. A target the blueprint never set stays a
 *    non-interactive `<span>`, which is the honest rendering of a button that
 *    was never pointed anywhere.
 *  - `custom-html` is absent: the Angular emitter writes a replica's markup
 *    into the page template directly, so this component never receives one.
 */

export const SECTION_COMPONENT_HTML = `<!-- Generated from the Site Blueprint. Edit the blueprint, not this file. -->
<ng-container [ngSwitch]="type">
  <!-- Navigation -->
  <header *ngSwitchCase="'nav'" class="nav">
    <div class="wrap nav-inner">
      <span class="brand">{{ companyName }}</span>
      <nav>
        <ng-container *ngFor="let item of nav">
          <a *ngIf="item.href && item.href.startsWith('/'); else navExternal" [routerLink]="item.href">{{ item.label }}</a>
          <ng-template #navExternal>
            <a *ngIf="item.href; else navPlain" [href]="item.href">{{ item.label }}</a>
            <ng-template #navPlain><span>{{ item.label }}</span></ng-template>
          </ng-template>
        </ng-container>
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
      <ng-container *ngIf="value('ctaLabel')">
        <a *ngIf="value('ctaHref').startsWith('/'); else heroCtaExternal" class="btn" [routerLink]="value('ctaHref')">{{ value('ctaLabel') }}</a>
        <ng-template #heroCtaExternal>
          <a *ngIf="value('ctaHref'); else heroCtaPlain" class="btn" [href]="value('ctaHref')">{{ value('ctaLabel') }}</a>
          <ng-template #heroCtaPlain><span class="btn">{{ value('ctaLabel') }}</span></ng-template>
        </ng-template>
      </ng-container>
    </div>
    <small *ngIf="credit() as c" class="credit">
      <a [href]="c.url" target="_blank" rel="noopener">{{ c.text }}</a>
    </small>
  </section>

  <!-- Card grids -->
  <section *ngSwitchCase="'value-props'" class="band">
    <div class="wrap">
      <h2>{{ value('headline', label) }}</h2>
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
      <h2>{{ value('headline', label) }}</h2>
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
      <h2>{{ value('headline', label) }}</h2>
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
        <h2>{{ value('headline', label) }}</h2>
        <p class="lede">{{ value('body') }}</p>
      </div>
      <img *ngIf="image(); else noMedia" class="media" [src]="image()" [alt]="imageAlt()" loading="lazy" />
      <ng-template #noMedia><div class="media empty"></div></ng-template>
    </div>
  </section>

  <section *ngSwitchCase="'teams'" class="band">
    <div class="wrap">
      <h2>{{ value('headline', label) }}</h2>
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
      <h2>{{ value('headline', label) }}</h2>
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
      <h2>{{ value('headline', label) }}</h2>
      <div *ngFor="let item of items; index as i" class="row">
        <h3>{{ item.title || 'Step ' + (i + 1) }}</h3>
        <p>{{ item.body }}</p>
      </div>
    </div>
  </section>

  <section *ngSwitchCase="'faq'" class="band narrow">
    <div class="wrap">
      <h2>{{ value('headline', label) }}</h2>
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
      <ng-container *ngIf="value('ctaLabel')">
        <a *ngIf="value('ctaHref').startsWith('/'); else ctaExternal" class="btn inverse" [routerLink]="value('ctaHref')">{{ value('ctaLabel') }}</a>
        <ng-template #ctaExternal>
          <a *ngIf="value('ctaHref'); else ctaPlain" class="btn inverse" [href]="value('ctaHref')">{{ value('ctaLabel') }}</a>
          <ng-template #ctaPlain><span class="btn inverse">{{ value('ctaLabel') }}</span></ng-template>
        </ng-template>
      </ng-container>
    </div>
  </section>

  <section *ngSwitchCase="'logo-wall'" class="band">
    <div class="wrap">
      <h2>{{ value('headline', label) }}</h2>
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
        <ng-container *ngFor="let item of nav">
          <a *ngIf="item.href && item.href.startsWith('/'); else footExternal" [routerLink]="item.href">{{ item.label }}</a>
          <ng-template #footExternal>
            <a *ngIf="item.href; else footPlain" [href]="item.href">{{ item.label }}</a>
            <ng-template #footPlain><span>{{ item.label }}</span></ng-template>
          </ng-template>
        </ng-container>
      </nav>
    </div>
    <div class="wrap legal">{{ value('legal', '© ' + year + ' ' + companyName) }}</div>
  </footer>

  <!-- rich-text, and anything the studio adds that this build does not know -->
  <section *ngSwitchDefault class="band narrow">
    <div class="wrap">
      <h2 *ngIf="value('headline')">{{ value('headline') }}</h2>
      <p class="lede">{{ value('body', label) }}</p>
    </div>
  </section>
</ng-container>
`;

/** The preview host's stylesheet, unchanged apart from losing `.custom-html`. */
export const SECTION_COMPONENT_SCSS = `/* Presentation sections, styled entirely from the blueprint's design tokens. */

:host {
  display: block;
  font-family: var(--brand-font-body);
  color: var(--brand-text);
}

.wrap {
  max-width: 1120px;
  margin: 0 auto;
  padding: 0 32px;
}
.wrap.center {
  text-align: center;
}

h1,
h2,
h3 {
  font-family: var(--brand-font-heading);
  letter-spacing: -0.02em;
  margin: 0;
}

h2 {
  font-size: 30px;
  margin-bottom: 8px;
}
h3 {
  font-size: 17px;
  margin-bottom: 6px;
}

p {
  margin: 0;
}

.lede {
  color: var(--brand-muted);
  font-size: 16px;
}
.role {
  color: var(--brand-muted);
  font-size: 13.5px;
}

.btn {
  display: inline-block;
  margin-top: 26px;
  padding: 13px 24px;
  font-weight: 600;
  text-decoration: none;
  background: var(--brand-accent);
  color: #fff;
  border-radius: var(--brand-radius);
}
.btn.inverse {
  background: #fff;
  color: var(--brand-accent);
}

/* Sections ---------------------------------------------------------------- */

.nav {
  background: #fff;
  border-bottom: 1px solid rgba(0, 0, 0, 0.08);
}
.nav-inner {
  display: flex;
  align-items: center;
  gap: 26px;
  height: 68px;
}
.nav-inner nav,
.footer-inner nav {
  display: flex;
  gap: 22px;
  margin-left: auto;
  flex-wrap: wrap;
}
.nav-inner a,
.nav-inner span {
  color: var(--brand-text);
  text-decoration: none;
  font-size: 14.5px;
}
.brand {
  font-family: var(--brand-font-heading);
  font-weight: 700;
  font-size: 17px;
}

.hero {
  position: relative;
  background: var(--brand-primary);
  color: #fff;
  padding: 88px 0;
  overflow: hidden;

  /* The image sits behind the copy, dimmed enough that the headline keeps a
     usable contrast ratio whatever photograph is chosen. */
  .hero-bg {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    object-fit: cover;
    opacity: 0.42;
  }
  .wrap {
    position: relative;
  }

  h1 {
    font-size: 52px;
    line-height: 1.08;
  }
  .lede {
    color: rgba(255, 255, 255, 0.86);
    font-size: 18.5px;
    margin-top: 16px;
    max-width: 620px;
  }
  .center .lede {
    margin-left: auto;
    margin-right: auto;
  }
}

.band {
  padding: 64px 0;
  background: var(--brand-background);
}
.band.tinted {
  background: var(--brand-surface);
}
.band.narrow .wrap {
  max-width: 760px;
}

.grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  gap: 22px;
  margin-top: 28px;
}

.card {
  background: #fff;
  border: 1px solid rgba(0, 0, 0, 0.08);
  border-radius: var(--brand-radius);
  padding: 20px;
}

/* Images are cropped to a consistent shape rather than allowed to set their own
   height — a grid of portraits at three different aspect ratios reads as an
   accident. \`.empty\` is the state before any image has been chosen. */
.photo {
  display: block;
  width: 100%;
  height: 150px;
  object-fit: cover;
  border-radius: var(--brand-radius);
  margin-bottom: 14px;
}
.photo.empty {
  background: #dde1e6;
}

.media {
  display: block;
  width: 100%;
  height: 280px;
  object-fit: cover;
  border-radius: var(--brand-radius);
}
.media.empty {
  background: var(--brand-surface);
}
.media.tall {
  height: 340px;
}

.tile {
  display: block;
  width: 100%;
  height: 140px;
  object-fit: cover;
  border-radius: var(--brand-radius);
  margin-bottom: 12px;
}

/* Attribution. Both stock licences require it on display, so it is part of the
   design rather than something bolted on later. */
.credit {
  position: absolute;
  right: 12px;
  bottom: 10px;
  font-size: 11px;
  opacity: 0.6;

  a {
    color: inherit;
    text-decoration: none;
  }
}
.credit.inline {
  position: static;
  display: block;
  margin-top: 6px;
  color: var(--brand-muted);
}

.split {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 40px;
  align-items: center;
}

blockquote {
  margin: 0;
  border-left: 3px solid var(--brand-accent);
  padding-left: 16px;

  footer {
    color: var(--brand-muted);
    font-size: 13.5px;
    margin-top: 8px;
  }
}

.stat {
  font-family: var(--brand-font-heading);
  font-size: 38px;
  font-weight: 700;
  color: var(--brand-accent);
}

.row {
  border-top: 1px solid rgba(0, 0, 0, 0.08);
  padding: 16px 0;
}

.logo {
  height: 56px;
  display: grid;
  place-items: center;
  border: 1px solid rgba(0, 0, 0, 0.08);
  border-radius: var(--brand-radius);
  color: var(--brand-muted);

  img {
    max-width: 80%;
    max-height: 70%;
    object-fit: contain;
  }
}

.cta {
  background: var(--brand-accent);
  color: #fff;
  padding: 64px 0;

  h2 {
    font-size: 36px;
  }
  p {
    opacity: 0.9;
    margin-top: 10px;
  }
}

.site-footer {
  background: var(--brand-primary);
  color: #fff;
  padding: 48px 0 30px;

  a,
  span:not(.brand) {
    color: rgba(255, 255, 255, 0.85);
    text-decoration: none;
    font-size: 14px;
  }
  .footer-inner {
    display: flex;
    align-items: center;
    gap: 24px;
    flex-wrap: wrap;
  }
  .legal {
    opacity: 0.55;
    font-size: 12.5px;
    margin-top: 24px;
  }
}

/* The library's own components are responsive; these follow the same breakpoint
   so the whole page turns over at one width rather than in pieces. */
@media (max-width: 720px) {
  .hero {
    padding: 56px 0;
    h1 {
      font-size: 34px;
    }
  }
  .band {
    padding: 44px 0;
  }
  .split {
    grid-template-columns: 1fr;
  }
  .wrap {
    padding: 0 20px;
  }
}
`;
