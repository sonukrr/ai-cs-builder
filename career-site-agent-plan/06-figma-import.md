# Figma Import Flow

## Objective
Convert an existing Figma design into a semantic site structure.

## Input
Figma file or node selected by the company administrator.

## Tool
Figma MCP.

## Workflow

### Step 1: Retrieve Design Context
Collect:
- Pages
- Frames
- Layer hierarchy
- Text
- Images/assets
- Colors
- Typography
- Components
- Layout information

### Step 2: Semantic Analysis
Do not immediately generate code.

Convert visual structure into meaning.

Example:

```text
Visual Frame
→ Hero
→ Job Search
→ Culture Section
→ Testimonials
→ Footer
```

### Step 3: Component Mapping
For each section:

```text
Is this functional?
→ Search zm-careers-lib registry

Is this reusable static content?
→ Search base site components

Otherwise
→ Create configurable static section
```

### Step 4: Design Tokens
Extract reusable:
- Colors
- Typography
- Spacing
- Border radius
- Button style

### Step 5: AI Site Plan
Show the admin:
- Detected pages
- Detected sections
- Functional components mapped
- Sections requiring custom implementation
- Confidence/assumptions

### Step 6: Approval
Only proceed to build after the plan is approved for major imports.

## MVP Constraint
Prioritize semantic similarity and reusable architecture over pixel-perfect Figma conversion.
