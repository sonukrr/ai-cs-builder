import { store } from "@/lib/store/store";
import { fidelity } from "@/lib/store/fidelity";
import { checkReviewable, generateFidelityReport } from "@/lib/fidelity";

export const runtime = "nodejs";
// Driving a real browser over a real preview host is slow, and the default
// serverless ceiling would cut the capture off mid-page.
export const maxDuration = 300;

/**
 * The design fidelity gate.
 *
 * `approve_plan` leaves an imported project in `reviewing` rather than `ready`,
 * and this route is the only way out of it: regenerate the comparison, look at
 * it, approve it. The approval is a human's click by design — the exact axes
 * can say a band is missing, but no threshold can say whether an approved
 * `lib-facets` standing in for a bespoke filter rail is acceptable, and a
 * machine that tried would lock every import out forever.
 */

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ projectId: string }> },
) {
  const { projectId } = await params;

  const project = await store.getProject(projectId);
  if (!project) return Response.json({ error: "No such project" }, { status: 404 });

  const [report, check] = await Promise.all([
    fidelity.get(projectId),
    checkReviewable(projectId),
  ]);

  return Response.json({
    report,
    /** False for a project this review does not apply to, with `reason` saying why. */
    available: check.ok,
    reason: check.ok ? "" : check.reason,
    /** The studio stays closed while this is true. */
    locked: project.status === "reviewing",
  });
}

/**
 * Regenerates the report, or — with `{ "approve": true }` — accepts it.
 *
 * Both live on POST because they are the same conversation: an administrator
 * regenerates until the evidence is worth accepting, then accepts that same
 * artefact. Approval deliberately does not regenerate first; it stamps the
 * report the human was actually looking at.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ projectId: string }> },
) {
  const { projectId } = await params;
  const body = (await request.json().catch(() => ({}))) as {
    approve?: boolean;
    approvedBy?: string;
  };

  const project = await store.getProject(projectId);
  if (!project) return Response.json({ error: "No such project" }, { status: 404 });

  if (body.approve) {
    const approved = await fidelity.approve(projectId, body.approvedBy ?? "company-admin");
    if (!approved) {
      return Response.json(
        { error: "There is no fidelity report to approve yet. Generate one first." },
        { status: 400 },
      );
    }
    const updated = await store.updateProject(projectId, { status: "ready" });
    return Response.json({ report: approved, project: updated, locked: false });
  }

  const outcome = await generateFidelityReport(projectId);
  if (!outcome.ok) return Response.json({ error: outcome.reason }, { status: 400 });

  return Response.json({
    report: outcome.report,
    available: true,
    reason: "",
    locked: project.status === "reviewing",
  });
}
