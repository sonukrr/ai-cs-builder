# Implementation Plan

## Phase 1: Foundation

### Tasks
1. Create Next.js application.
2. Create project data model.
3. Define Site Blueprint schema.
4. Create component registry from `zm-careers-lib`.
5. Prepare base career site repository.

### Deliverable
A static Career Site Studio capable of rendering a sample blueprint.

---

## Phase 2: Base Site Flow

### Tasks
1. Connect GitHub MCP.
2. Read base repository structure.
3. Load approved pages and components.
4. Create project from base.
5. Generate first Site Blueprint.
6. Render preview.

### Deliverable
"Start From Base" works end-to-end.

---

## Phase 3: Figma Import

### Tasks
1. Connect Figma MCP.
2. Retrieve selected design context.
3. Convert design into semantic sections.
4. Map functional sections to component registry.
5. Generate AI Site Plan.
6. Generate Site Blueprint after approval.

### Deliverable
"Import Figma" creates an editable site blueprint.

---

## Phase 4: Conversational Modification

### Tasks
1. Add orchestrator intent routing.
2. Provide current page/section context.
3. Update Site Blueprint through structured operations.
4. Generate change summary.
5. Refresh preview.
6. Save version.

### Deliverable
User can modify the site through natural language.

---

## Phase 5: GitHub + Preview

### Tasks
1. Create company-specific branch.
2. Write controlled configuration changes.
3. Commit changes.
4. Trigger preview deployment.
5. Store preview URL.

### Deliverable
Every meaningful version can have a preview.

---

## Phase 6: Publish Request

### Tasks
1. Run blueprint validation.
2. Generate change summary.
3. Create publish request.
4. Persist approval status.

### Deliverable
Company can request publication without direct production access.
