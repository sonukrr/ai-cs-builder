import { NgModule } from "@angular/core";
import { BrowserModule } from "@angular/platform-browser";
import { BrowserAnimationsModule } from "@angular/platform-browser/animations";
import { HTTP_INTERCEPTORS, HttpClientModule } from "@angular/common/http";
import { FormsModule, ReactiveFormsModule } from "@angular/forms";
import { RouterModule } from "@angular/router";
import { ZmCareerSitesLibModule } from "zm-careers-lib";

import { AppComponent } from "./app.component";
import { SectionHostComponent } from "./section-host.component";
import { StaticSectionComponent } from "./static-section.component";
import { MockApiInterceptor } from "./mock/mock-api.interceptor";

/**
 * The library's components inject ActivatedRoute, so a router has to be present
 * even though this app has no routes of its own — hence the empty
 * `RouterModule.forRoot`. Without it, JobsListComponent fails to construct.
 *
 * SectionHostComponent renders itself for the children of a layout container.
 * Declaring it here is the whole requirement: the selector is resolved through
 * the module, so the self-reference costs nothing.
 */
@NgModule({
  declarations: [AppComponent, SectionHostComponent, StaticSectionComponent],
  imports: [
    BrowserModule,
    BrowserAnimationsModule,
    HttpClientModule,
    FormsModule,
    ReactiveFormsModule,
    RouterModule.forRoot([], { useHash: true }),
    ZmCareerSitesLibModule,
  ],
  providers: [{ provide: HTTP_INTERCEPTORS, useClass: MockApiInterceptor, multi: true }],
  bootstrap: [AppComponent],
})
export class AppModule {}
