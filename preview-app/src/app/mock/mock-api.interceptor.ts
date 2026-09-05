import { Injectable } from "@angular/core";
import {
  HttpEvent,
  HttpHandler,
  HttpInterceptor,
  HttpRequest,
  HttpResponse,
} from "@angular/common/http";
import { Observable, of, throwError } from "rxjs";
import { delay } from "rxjs/operators";
import {
  mockApplyFieldsResponse,
  mockCompanyConfigResponse,
  mockFileConfigResponse,
  mockJobResponse,
  mockSearchResponse,
  mockTenantResponse,
} from "./mock-data";
import { isMocked, MOCK_HOST, type DataSource } from "../preview-config";

/**
 * Answers the library's HTTP calls from fixtures when the preview is in mock
 * mode.
 *
 * Intercepting at the HTTP layer rather than stubbing the library's services
 * means the *real* components run in both modes — same rendering, same
 * pagination arithmetic, same facet behaviour. Only the bytes differ. That is
 * what makes mock mode a fair preview rather than a mock-up of one.
 *
 * In live mode this passes everything straight through.
 */
@Injectable()
export class MockApiInterceptor implements HttpInterceptor {
  /** Set by main.ts before the first request. */
  static source: DataSource = "sample";

  /**
   * The sentinel host mock mode points the library at.
   *
   * Scoping to it matters: the app also fetches its blueprint from the studio's
   * API, and an interceptor that answered *every* request would swallow that
   * too — which is exactly what it did before this check existed.
   */
  static readonly MOCK_HOST = MOCK_HOST;

  /** A touch of latency so loading states are visible rather than skipped. */
  private static readonly LATENCY_MS = 220;

  intercept(request: HttpRequest<unknown>, next: HttpHandler): Observable<HttpEvent<unknown>> {
    if (!isMocked(MockApiInterceptor.source)) return next.handle(request);
    if (!request.url.startsWith(MockApiInterceptor.MOCK_HOST)) return next.handle(request);

    const body = this.respond(request);
    if (body === undefined) {
      // An endpoint the fixtures do not cover. Failing loudly beats returning
      // an empty success that renders as a mysteriously blank section.
      return throwError(
        () =>
          new Error(
            `[preview] No mock fixture for ${request.method} ${request.url}. ` +
              `Switch the preview to live data, or add a fixture in mock-data.ts.`,
          ),
      );
    }

    return of(new HttpResponse({ status: 200, body })).pipe(delay(MockApiInterceptor.LATENCY_MS));
  }

  /** Routes by endpoint path, matching how EndpointsService builds its URLs. */
  private respond(request: HttpRequest<unknown>): unknown {
    const url = request.url;

    if (url.includes("tenant_management/tenant/group")) return mockTenantResponse();

    if (url.includes("jobs/search") || url.includes("manageESQueries/searchJob")) {
      return mockSearchResponse(this.filterCriteria(request));
    }

    if (url.includes("jobs-service/v1/jobs/careersite") || url.includes("/core/v2/job/")) {
      return mockJobResponse(this.jobUrlOf(request));
    }

    if (url.includes("careersite-configurations") || url.includes("data-service/v2/company/")) {
      return mockCompanyConfigResponse();
    }

    if (url.includes("apply_fields/company") || url.includes("getReqFieldsForCareersSite")) {
      return mockApplyFieldsResponse();
    }

    if (url.includes("supportedFileTypeAndSize")) return mockFileConfigResponse();

    // The apply and parse flows are write paths; acknowledge without pretending
    // a real application was filed.
    if (url.includes("applyJob") || url.includes("talentCommunityApply")) {
      return { code: 200, message: "Preview mode — no application was submitted.", data: { applyId: "preview" } };
    }
    if (url.includes("resume/parse")) {
      return { code: 200, data: { candidate: {}, recommendedJobs: [] } };
    }
    if (url.includes("maps/autocomplete")) return { code: 200, data: [] };
    if (url.includes("recaptcha") || url.includes("RecaptchaSiteKey")) {
      return { code: 200, data: { siteKey: "" } };
    }
    if (url.includes("trackCampaign") || url.includes("Engagement")) return { code: 200, data: {} };

    return undefined;
  }

  /** The library posts `filterCri` as a JSON string inside FormData. */
  private filterCriteria(request: HttpRequest<unknown>): Record<string, unknown> {
    const body = request.body;
    if (!(body instanceof FormData)) return {};
    const raw = body.get("filterCri");
    if (typeof raw !== "string") return {};
    try {
      return JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return {};
    }
  }

  private jobUrlOf(request: HttpRequest<unknown>): string {
    const fromParam = request.params.get("jobUrl") ?? request.params.get("joburl");
    if (fromParam) return fromParam;
    const segments = request.url.split("/").filter(Boolean);
    return segments[segments.length - 1] ?? "";
  }
}
