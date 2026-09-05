import { NgModule } from "@angular/core";
import { BrowserModule } from "@angular/platform-browser";
import { BrowserAnimationsModule } from "@angular/platform-browser/animations";
import { HTTP_INTERCEPTORS, HttpClientModule } from "@angular/common/http";
import { FormsModule, ReactiveFormsModule } from "@angular/forms";
import { RouterModule } from "@angular/router";
import { ZmCareerSitesLibModule } from "zm-careers-lib";

import { AppComponent } from "./app.component";
import { StaticSectionComponent } from "./static-section.component";
import { MockApiInterceptor } from "./mock/mock-api.interceptor";

/**
 * The library's components inject ActivatedRoute, so a router has to be present
 * even though this app has no routes of its own — hence the empty
 * `RouterModule.forRoot`. Without it, JobsListComponent fails to construct.
 */
@NgModule({
  declarations: [AppComponent, StaticSectionComponent],
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
